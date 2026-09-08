import { Array, Effect, Equivalence, FileSystem, flow, Function, HashMap, HashSet, Match, Option, Order, pipe, Predicate, Record, Schema, Stdio, Stream } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import { SqlClient, Statement } from "effect/unstable/sql"
import { MigrationError, SchemaStore } from "./migrations.ts"
import {
  Table,
  TableField,
  TableSnapshot,
} from "./table.ts"
import { renderColumn, renderCreateTable } from "./sqlite-ddl.ts"

const SchemaVersion = 1
const LedgerTable = "_effect_schema_migrations"


const MigrationValueSchema = Schema.Union([Schema.String, Schema.Number, Schema.Null])
const SchemaVersionSchema = Schema.Literal(SchemaVersion)
const TableSnapshotsSchema = Schema.Array(TableSnapshot)

type MigrationValue = Schema.Schema.Type<typeof MigrationValueSchema>

export class SqliteSchemaSnapshot extends Schema.Class<SqliteSchemaSnapshot>(
  "SqliteSchemaSnapshot",
)({
  version: SchemaVersionSchema,
  tables: TableSnapshotsSchema,
}) {}

export class SqliteRename extends Schema.Class<SqliteRename>("SqliteRename")({
  table: Schema.String,
  from: Schema.String,
  to: Schema.String,
}) {}

export class SqliteBackfill extends Schema.Class<SqliteBackfill>("SqliteBackfill")({
  table: Schema.String,
  column: Schema.String,
  value: MigrationValueSchema,
}) {}

/**
 * `expression` is evaluated against physical `from` columns because rebuilding
 * or renaming the table would otherwise change the expression's meaning.
 */
export class SqliteTransform extends Schema.Class<SqliteTransform>("SqliteTransform")({
  table: Schema.String,
  column: Schema.String,
  expression: Schema.String,
}) {}

class SqliteColumnSource extends Schema.TaggedClass<SqliteColumnSource>()(
  "SqliteColumnSource",
  {
    column: Schema.String,
    source: Schema.String,
  },
) {}

class SqliteColumnValue extends Schema.TaggedClass<SqliteColumnValue>()(
  "SqliteColumnValue",
  {
    column: Schema.String,
    value: MigrationValueSchema,
  },
) {}

class SqliteColumnExpression extends Schema.TaggedClass<SqliteColumnExpression>()(
  "SqliteColumnExpression",
  {
    column: Schema.String,
    expression: Schema.String,
  },
) {}

const SqliteColumnCopySchema = Schema.Union([
  SqliteColumnSource,
  SqliteColumnValue,
  SqliteColumnExpression,
])


class SqliteCreateTable extends Schema.TaggedClass<SqliteCreateTable>()(
  "SqliteCreateTable",
  { table: TableSnapshot },
) {}

class SqliteAddColumn extends Schema.TaggedClass<SqliteAddColumn>()(
  "SqliteAddColumn",
  {
    table: Schema.String,
    column: TableField,
  },
) {}

class SqliteRenameColumn extends Schema.TaggedClass<SqliteRenameColumn>()(
  "SqliteRenameColumn",
  {
    table: Schema.String,
    from: Schema.String,
    to: Schema.String,
  },
) {}

const SqliteColumnCopiesSchema = Schema.Array(SqliteColumnCopySchema)

class SqliteRebuildTable extends Schema.TaggedClass<SqliteRebuildTable>()(
  "SqliteRebuildTable",
  {
    table: TableSnapshot,
    copies: SqliteColumnCopiesSchema,
  },
) {}

class SqliteBlockedChange extends Schema.TaggedClass<SqliteBlockedChange>()(
  "SqliteBlockedChange",
  { reason: Schema.String },
) {}

const SqliteMigrationStepSchema = Schema.Union([
  SqliteCreateTable,
  SqliteAddColumn,
  SqliteRenameColumn,
  SqliteRebuildTable,
  SqliteBlockedChange,
])

type SqliteMigrationStep = Schema.Schema.Type<typeof SqliteMigrationStepSchema>

const SqliteMigrationStepsSchema = Schema.Array(SqliteMigrationStepSchema)

export class SqliteMigration extends Schema.Class<SqliteMigration>("SqliteMigration")({
  id: Schema.String,
  from: SqliteSchemaSnapshot,
  to: SqliteSchemaSnapshot,
  steps: SqliteMigrationStepsSchema,
}) {}

const SqliteRenameArraySchema = Schema.Array(SqliteRename)
const SqliteBackfillArraySchema = Schema.Array(SqliteBackfill)
const SqliteTransformArraySchema = Schema.Array(SqliteTransform)
const EmptyRenames = Effect.succeed([])
const EmptyBackfills = Effect.succeed([])
const EmptyTransforms = Effect.succeed([])

const SqliteRenamesSchema = pipe(
  SqliteRenameArraySchema,
  Schema.withConstructorDefault(EmptyRenames),
)

const SqliteBackfillsSchema = pipe(
  SqliteBackfillArraySchema,
  Schema.withConstructorDefault(EmptyBackfills),
)

const SqliteTransformsSchema = pipe(
  SqliteTransformArraySchema,
  Schema.withConstructorDefault(EmptyTransforms),
)


class SqliteMigrationPlanOptions extends Schema.Class<SqliteMigrationPlanOptions>(
  "SqliteMigrationPlanOptions",
)({
  id: Schema.String,
  from: SqliteSchemaSnapshot,
  to: SqliteSchemaSnapshot,
  renames: SqliteRenamesSchema,
  backfills: SqliteBackfillsSchema,
  transforms: SqliteTransformsSchema,
}) {}

const freeze = <A>(value: A): A => {
  const isObject = Predicate.isObjectKeyword(value)
  if (!isObject) {
    return value
  }

  const isFrozen = Object.isFrozen(value)
  if (isFrozen) {
    return value
  }

  const values = Record.values(value as Record.ReadonlyRecord<string, unknown>)
  Array.forEach(values, freeze)
  return Object.freeze(value)
}

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return Array.map(value, sortJson)
  }

  const isRecord = Predicate.isObject(value)
  if (!isRecord) {
    return value
  }

  const entries = Record.toEntries(value as Record.ReadonlyRecord<string, unknown>)
  const sortedEntries = Array.sortWith(entries, ([key]) => key, Order.String)

  const sortedValues = Array.map(
    sortedEntries,
    ([key, nested]) => [key, sortJson(nested)] as const,
  )

  return Record.fromEntries(sortedValues)
}

const canonical = flow(JSON.stringify, JSON.parse, sortJson)
const canonicalText = flow(canonical, JSON.stringify)

const same = <A>(left: A, right: A) => {
  const leftText = canonicalText(left)
  const rightText = canonicalText(right)
  return Equivalence.strictEqual<string>()(leftText, rightText)
}

const schemaSnapshot = (tables: ReadonlyArray<TableSnapshot>) =>
  pipe(
    SqliteSchemaSnapshot.make({
      version: SchemaVersion,
      tables: [...tables],
    }),
    freeze,
  )


const InitialSnapshot = schemaSnapshot([])

const emptySnapshot = Function.constant(InitialSnapshot)

const fieldWithoutName = (field: TableField) => {
  const { name: _, ...rest } = field
  return rest
}

const fieldEntry = (field: TableField) => [field.name, field] as const
const tableEntry = (table: TableSnapshot) => [table.name, table] as const

const fieldMap = (table: TableSnapshot) =>
  pipe(table.fields, Array.map(fieldEntry), HashMap.fromIterable)

const tableMap = (snapshot: SqliteSchemaSnapshot) =>
  pipe(snapshot.tables, Array.map(tableEntry), HashMap.fromIterable)

const duplicateIntentKeys = <A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
) => {
  const seen = new Set<string>()
  const duplicates: Array<string> = []
  for (const value of values) {
    const valueKey = key(value)
    if (seen.has(valueKey)) {
      duplicates.push(valueKey)
    } else {
      seen.add(valueKey)
    }
  }
  return duplicates
}

const identifiers = (snapshot: SqliteSchemaSnapshot): ReadonlyArray<string> => {
  const tableNames = new Set<string>()
  const errors: Array<string> = []
  for (const table of snapshot.tables) {
    if (table.name.length === 0 || table.identifier.length === 0) {
      errors.push("table names and identifiers must not be empty")
    }
    if (tableNames.has(table.name)) {
      errors.push(`table ${table.name} occurs more than once`)
    } else {
      tableNames.add(table.name)
    }

    const fieldNames = new Set<string>()
    for (const field of table.fields) {
      if (field.name.length === 0) {
        errors.push(`table ${table.name} contains an empty field name`)
      }
      if (fieldNames.has(field.name)) {
        errors.push(`table ${table.name} contains field ${field.name} more than once`)
      } else {
        fieldNames.add(field.name)
      }
    }
    if (!fieldNames.has(table.identifier)) {
      errors.push(`table ${table.name} has no identifier field ${table.identifier}`)
    }
  }
  return errors
}

const blocked = flow((reason: string) => SqliteBlockedChange.make({ reason }), freeze)

const normalizedFieldEquals = (left: TableField, right: TableField) => {
  const normalizedLeft = fieldWithoutName(left)
  const normalizedRight = fieldWithoutName(right)
  return same(normalizedLeft, normalizedRight)
}

const intentMap = <A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
) => {
  const entryForValue = (value: A) => [key(value), value] as const
  return pipe(values, Array.map(entryForValue), HashMap.fromIterable)
}

const snapshotFromTable = flow(Array.map(Table.snapshot), schemaSnapshot)

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`

const normalizedSql = (sql: string) => {

  const tokens = sql.trim().replace(/;$/, "").match(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[^\s]/g,
  ) ?? []

  return Array.join(tokens, "\u0000")
}

function migrationFailure(reason: string): MigrationError
function migrationFailure(reason: string, cause: unknown): MigrationError

function migrationFailure(reason: string, ...causes: ReadonlyArray<unknown>) {
  return causes.length === 0
    ? MigrationError.make({ reason })
    : MigrationError.make({ reason, cause: causes[0] })
}

const SqliteSnapshotJsonSchema = Schema.toCodecJson(SqliteSchemaSnapshot)
const SqliteSnapshotSourceSchema = Schema.fromJsonString(SqliteSnapshotJsonSchema)
const SqliteMigrationJsonSchema = Schema.toCodecJson(SqliteMigration)
const SqliteMigrationSourceSchema = Schema.fromJsonString(SqliteMigrationJsonSchema)

const encodeSnapshot = Schema.encodeUnknownSync(SqliteSnapshotJsonSchema)
const encodeMigration = Schema.encodeUnknownSync(SqliteMigrationJsonSchema)

const SqliteMigrationHistorySchema = Schema.Array(SqliteMigrationJsonSchema)

const SqliteMigrationManifestSchema = Schema.Struct({
  migrations: Schema.Array(Schema.String),
})

const SqliteMigrationManifestSourceSchema = Schema.fromJsonString(
  SqliteMigrationManifestSchema,
)

const decodeSnapshot = (source: string) =>
  pipe(
    Schema.decodeUnknownEffect(SqliteSnapshotSourceSchema)(source),
    Effect.mapError((cause) => migrationFailure("invalid SQLite schema snapshot", cause)),
    Effect.map(freeze),
  )

const decodeMigration = (source: string) =>
  pipe(
    Schema.decodeUnknownEffect(SqliteMigrationSourceSchema)(source),
    Effect.mapError((cause) => migrationFailure("invalid SQLite migration artifact", cause)),
    Effect.map(freeze),
  )

const migrationTo = (migration: SqliteMigration) => freeze(migration.to)
const decodeMigrationTarget = flow(decodeMigration, Effect.map(migrationTo))

const decodeSource = (source: string) =>
  pipe(
    decodeSnapshot(source),
    Effect.catch(() => decodeMigrationTarget(source)),
  )

const sqlExpressionIsValid = (expression: string): boolean =>
  expression.trim().length > 0 &&
  !expression.includes("\u0000") &&
  !expression.includes(";") &&
  !expression.includes("--") &&
  !expression.includes("/*")

const decodeSqliteRows = <S extends Schema.Top>(schema: S) =>
  Effect.flatMap(Schema.decodeUnknownEffect(schema))

const applyStatement = (sql: SqlClient.SqlClient, statement: string) =>
  pipe(
    sql`${sql.literal(statement)}`,
    Effect.asVoid,
    Effect.mapError((cause) => migrationFailure("SQLite schema operation failed", cause)),
  )

const ensureMetadata = (sql: SqlClient.SqlClient) =>
  applyStatement(
    sql,
    `CREATE TABLE IF NOT EXISTS ${quote(LedgerTable)} (position INTEGER PRIMARY KEY NOT NULL, id TEXT UNIQUE NOT NULL, artifact TEXT NOT NULL)`,
  )

const SqliteNullableStringSchema = Schema.NullOr(Schema.String)
const SqliteTableObjectRowSchema = Schema.Struct({ name: Schema.String })
interface SqliteTableObjectRow extends Schema.Schema.Type<typeof SqliteTableObjectRowSchema> {}

const SqliteMigrationRowSchema = Schema.Struct({
  id: Schema.String,
  artifact: Schema.String,
})

interface SqliteMigrationRow extends Schema.Schema.Type<typeof SqliteMigrationRowSchema> {}

const SqliteTableSqlRowSchema = Schema.Struct({ sql: SqliteNullableStringSchema })
interface SqliteTableSqlRow extends Schema.Schema.Type<typeof SqliteTableSqlRowSchema> {}
const SqliteTableObjectRowsSchema = Schema.Array(SqliteTableObjectRowSchema)
const SqliteMigrationRowsSchema = Schema.Array(SqliteMigrationRowSchema)
const SqliteTableSqlRowsSchema = Schema.Array(SqliteTableSqlRowSchema)
const decodeTableObjectRows = decodeSqliteRows(SqliteTableObjectRowsSchema)
const decodeMigrationRows = decodeSqliteRows(SqliteMigrationRowsSchema)
const decodeTableSqlRows = decodeSqliteRows(SqliteTableSqlRowsSchema)


const untrackedTableObjects = (sql: SqlClient.SqlClient, table: string) => {
  const objectNames = (rows: ReadonlyArray<SqliteTableObjectRow>) =>
    Array.map(rows, (row) => `${row.name}`)

  return pipe(
    sql`SELECT name FROM sqlite_master
      WHERE tbl_name = ${table} AND type IN ('index', 'trigger')
        AND name NOT LIKE 'sqlite_autoindex_%'`,
    decodeTableObjectRows,
    Effect.map(objectNames),
    Effect.mapError((cause) => migrationFailure(`could not inspect table ${table}`, cause)),
  )
}

const rejectUntrackedTableObjects = (sql: SqlClient.SqlClient, table: string) => {
  const rejectObjects = (objects: ReadonlyArray<string>) => {
    const hasNoObjects = Equivalence.strictEqual<number>()(objects.length, 0)
    if (hasNoObjects) {
      return Effect.void
    }

    const error = migrationFailure(`SQLite contains untracked indexes or triggers for table ${table}`)
    return Effect.fail(error)
  }

  return pipe(untrackedTableObjects(sql, table), Effect.flatMap(rejectObjects))
}

const recordedMigrations = (sql: SqlClient.SqlClient) => {
  const ledger = sql(LedgerTable)
  return pipe(
    sql`SELECT id, artifact FROM ${ledger} ORDER BY position`,
    decodeMigrationRows,
    Effect.mapError((cause) => migrationFailure("could not read SQLite migration history", cause)),
  )
}


const recordMigration = (
  sql: SqlClient.SqlClient,
  migration: SqliteMigration,
  position: number,
) => {
  const artifact = canonicalText(migration)
  return pipe(
    sql`INSERT INTO ${sql(LedgerTable)} (position, id, artifact) VALUES (${position}, ${migration.id}, ${artifact})`,
    Effect.asVoid,
    Effect.mapError((cause) => migrationFailure("could not record SQLite migration", cause)),
  )
}

const userTables = (sql: SqlClient.SqlClient) => {
  const namesFromSqlitetableobjectrow = (rows: ReadonlyArray<SqliteTableObjectRow>) =>
    Array.map(rows, (sqliteTableObjectRow) => `${sqliteTableObjectRow.name}`)

  return pipe(
    sql`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        AND name NOT IN (${LedgerTable})
      ORDER BY name`,
    decodeTableObjectRows,
    Effect.map(namesFromSqlitetableobjectrow),
    Effect.mapError((cause) => migrationFailure("could not inspect SQLite schema", cause)),
  )
}

const tableSql = (sql: SqlClient.SqlClient, name: string) => {
  const firstRowSql = (rows: ReadonlyArray<SqliteTableSqlRow>) => {
    const first = Array.head(rows)
    return Option.match(first, {
      onNone: Function.constant(null),
      onSome: (sqliteTableSqlRow) => `${sqliteTableSqlRow.sql}`,
    })
  }

  return pipe(
    sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${name}`,
    decodeTableSqlRows,
    Effect.map(firstRowSql),
    Effect.mapError((cause) => migrationFailure(`could not inspect table ${name}`, cause)),
  )
}

const verifyDatabase = Effect.fn("SqliteMigrations.verifyDatabase")(function* (
  sql: SqlClient.SqlClient,
  snapshot: SqliteSchemaSnapshot,
) {
  const names = yield* userTables(sql)
  const expectedEntries = Array.map(snapshot.tables, tableEntry)
  const nameFromTablesnapshot = ([name]: readonly [string, TableSnapshot]) => name
  const expectedNames = Array.map(expectedEntries, nameFromTablesnapshot)
  const expected = HashSet.fromIterable(expectedNames)
  const expectedCount = HashSet.size(expected)
  const matchingTableCount = Equivalence.strictEqual<number>()(names.length, expectedCount)
  const tableIsExpected = (name: string) => HashSet.has(expected, name)
  const everyTableIsExpected = Array.every(names, tableIsExpected)
  const namesMatchHistory = matchingTableCount && everyTableIsExpected

  if (!namesMatchHistory) {
    return yield* migrationFailure("SQLite contains tables not tracked by the schema migration history")
  }

  const verifyTable = Effect.fn("SqliteMigrations.verifyTable")(function* (table: TableSnapshot) {
    yield* rejectUntrackedTableObjects(sql, table.name)
    const actual = yield* tableSql(sql, table.name)
    if (!Predicate.isString(actual)) {
      return yield* migrationFailure(`SQLite schema drift detected for table ${table.name}`)
    }

    const actualSql = normalizedSql(actual)
    const expectedCreateStatement = renderCreateTable(table)
    const expectedSql = normalizedSql(expectedCreateStatement)
    const matchesExpectedSql = Equivalence.strictEqual<string>()(actualSql, expectedSql)
    if (matchesExpectedSql) {
      return yield* Effect.void
    }

    // SQLite appends added columns because named records are declaration-order independent.

    const columns = yield* pipe(
      sql`
        SELECT name FROM pragma_table_info(${table.name}) ORDER BY cid
      `,
      decodeTableObjectRows,
      Effect.mapError((cause) => migrationFailure(`could not inspect columns for ${table.name}`, cause)),
    )

    const fields = fieldMap(table)
    const fieldOptionForColumn = (column: SqliteTableObjectRow) => HashMap.get(fields, column.name)
    const orderedFieldOptions = Array.map(columns, fieldOptionForColumn)
    if (Array.some(orderedFieldOptions, Option.isNone)) {
      return yield* migrationFailure(`SQLite schema drift detected for table ${table.name}`)
    }

    const orderedFields = Array.getSomes(orderedFieldOptions)
    const physicalTable = TableSnapshot.make({ ...table, fields: orderedFields })
    const matchingFieldCount = Equivalence.strictEqual<number>()(orderedFields.length, table.fields.length)
    const physicalCreateStatement = renderCreateTable(physicalTable)
    const physicalSql = normalizedSql(physicalCreateStatement)
    const matchesPhysicalSql = Equivalence.strictEqual<string>()(actualSql, physicalSql)
    const physicalTableMatches = matchingFieldCount && matchesPhysicalSql
    const hasSchemaDrift = !physicalTableMatches
    if (hasSchemaDrift) {
      return yield* migrationFailure(`SQLite schema drift detected for table ${table.name}`)
    }
  })

  yield* Effect.forEach(snapshot.tables, verifyTable, { discard: true })
})

const runStep = Effect.fn("SqliteMigrations.runStep")(function* (
  sql: SqlClient.SqlClient,
  step: SqliteMigrationStep,
) {
  const rebuildTable = Effect.fn("SqliteMigrations.rebuildTable")(function* (
    rebuild: SqliteRebuildTable,
  ) {
    yield* rejectUntrackedTableObjects(sql, rebuild.table.name)
    const temporary = `__effect_schema_${rebuild.table.name}`
    const temporaryTable = TableSnapshot.make({ ...rebuild.table, name: temporary })
    const copiedColumns = Array.map(rebuild.copies, (copy) => [copy.column] as const)
    const columnNames = pipe(copiedColumns, Array.map(([column]) => column), Array.map(quote))
    const columns = Array.join(columnNames, ", ")

    const sqlFragmentFromSqlitecolumnsource = (sqliteColumnSource: SqliteColumnSource) =>
      pipe(sqliteColumnSource.source, quote, sql.literal)

    const sqlFragmentFromSqlitecolumnvalue = (sqliteColumnValue: SqliteColumnValue) => {
      const parameter = Statement.parameter(sqliteColumnValue.value)
      return Statement.fragment([parameter])
    }

    const sqlFragmentFromSqlitecolumnexpression = (sqliteColumnExpression: SqliteColumnExpression) =>
      sql.literal(sqliteColumnExpression.expression)

    const sqlFragment = (
      sqliteColumnCopy: SqliteColumnSource | SqliteColumnValue | SqliteColumnExpression,
    ) =>
      pipe(
        Match.value(sqliteColumnCopy),
        Match.tagsExhaustive({
          SqliteColumnSource: sqlFragmentFromSqlitecolumnsource,
          SqliteColumnValue: sqlFragmentFromSqlitecolumnvalue,
          SqliteColumnExpression: sqlFragmentFromSqlitecolumnexpression,
        }),
      )

    const expressions = Array.map(rebuild.copies, sqlFragment)
    const expressionsFragment = sql.join(", ", false)(expressions)
    const columnsFragment = sql.literal(columns)
    const quotedTemporary = quote(temporary)
    const temporaryFragment = sql.literal(quotedTemporary)
    const quotedSource = quote(rebuild.table.name)
    const sourceFragment = sql.literal(quotedSource)
    const createTemporaryStatement = renderCreateTable(temporaryTable)
    yield* applyStatement(sql, createTemporaryStatement)
    yield* pipe(
      sql`INSERT INTO ${temporaryFragment} (${columnsFragment}) SELECT ${expressionsFragment} FROM ${sourceFragment}`,
      Effect.asVoid,
      Effect.mapError((cause) => migrationFailure("SQLite schema operation failed", cause)),
    )
    const dropSourceStatement = `DROP TABLE ${quotedSource}`
    yield* applyStatement(sql, dropSourceStatement)
    const renameStatement = `ALTER TABLE ${quotedTemporary} RENAME TO ${quotedSource}`
    return yield* applyStatement(sql, renameStatement)
  })

  const createTable = (create: SqliteCreateTable) => {
    const statement = renderCreateTable(create.table)
    return applyStatement(sql, statement)
  }

  const addColumn = (addition: SqliteAddColumn) => {
    const quotedTable = quote(addition.table)
    const bareTable = TableSnapshot.make({ name: addition.table, identifier: "", fields: [] })
    const column = renderColumn(bareTable, addition.column)
    const statement = `ALTER TABLE ${quotedTable} ADD COLUMN ${column}`
    return applyStatement(sql, statement)
  }

  const renameColumn = (rename: SqliteRenameColumn) => {
    const quotedTable = quote(rename.table)
    const quotedFrom = quote(rename.from)
    const quotedTo = quote(rename.to)
    const statement = `ALTER TABLE ${quotedTable} RENAME COLUMN ${quotedFrom} TO ${quotedTo}`
    return applyStatement(sql, statement)
  }

  const failBlockedChange = (change: SqliteBlockedChange) => migrationFailure(change.reason)

  return yield* pipe(
    Match.value(step),
    Match.tagsExhaustive({
      SqliteCreateTable: createTable,
      SqliteAddColumn: addColumn,
      SqliteRenameColumn: renameColumn,
      SqliteRebuildTable: rebuildTable,
      SqliteBlockedChange: failBlockedChange,
    }),
  )
})

const applyMigration = (
  sql: SqlClient.SqlClient,
  migration: SqliteMigration,
  position: number,
) => {

  const migrationError = (cause: unknown) =>
    Schema.is(MigrationError)(cause)
      ? cause
      : migrationFailure(`could not apply migration ${migration.id}`, cause)

  const applyStep = (step: SqliteMigrationStep) => runStep(sql, step)

  const replayMigration = Effect.fn("SqliteMigrations.replayMigration")(function*() {
    yield* Effect.forEach(migration.steps, applyStep, { discard: true })
    yield* verifyDatabase(sql, migration.to)
    yield* recordMigration(sql, migration, position)
  })

  const replayEffect = replayMigration()
  const transaction = sql.withTransaction(replayEffect)
  return pipe(transaction, Effect.mapError(migrationError))
}

const validateHistory = (migrations: ReadonlyArray<SqliteMigration>) => {
  const emptyError = Option.none<string>()
  const initialPrevious = emptySnapshot()
  const initialSeen = HashSet.empty<string>()
  const initial = [emptyError, initialPrevious, initialSeen] as const

  const validateMigration = (
    [error, previous, seen]: readonly [
      Option.Option<string>,
      SqliteSchemaSnapshot,
      HashSet.HashSet<string>,
    ],
    migration: SqliteMigration,
  ) => {

    if (Option.isSome(error)) {
      return [error, previous, seen] as const
    }

    const duplicateId = HashSet.has(seen, migration.id)
    const hasEmptyId = Equivalence.strictEqual<number>()(migration.id.length, 0)
    const invalidId = hasEmptyId ? true : duplicateId
    if (invalidId) {
      const duplicateError = Option.some("migration ids must be unique non-empty strings")
      return [duplicateError, previous, seen] as const
    }

    const inputErrors = identifiers(migration.from)
    const outputErrors = identifiers(migration.to)
    const identityErrors = Array.appendAll(inputErrors, outputErrors)
    if (identityErrors.length > 0) {
      const message = Array.join(identityErrors, "; ")
      const identityError = Option.some(message)
      return [identityError, previous, seen] as const
    }

    const hasMatchingPrevious = same(previous, migration.from)
    if (!hasMatchingPrevious) {

      const continuityError = Option.some(
        `migration ${migration.id} does not begin at the preceding frozen snapshot`,
      )

      return [continuityError, previous, seen] as const
    }

    const hasBlockedChange = Array.some(migration.steps, Schema.is(SqliteBlockedChange))
    if (hasBlockedChange) {
      const blockedError = Option.some(`migration ${migration.id} contains unresolved changes`)
      return [blockedError, previous, seen] as const
    }

    const nextSeen = HashSet.add(seen, migration.id)
    return [emptyError, migration.to, nextSeen] as const
  }

  const [error] = Array.reduce(migrations, initial, validateMigration)
  return error
}

const validateDecodedHistory = (
  migrations: ReadonlyArray<SqliteMigration>,
): Effect.Effect<ReadonlyArray<SqliteMigration>, MigrationError> => {
  const error = validateHistory(migrations)
  if (Option.isSome(error)) {
    return Effect.fail(migrationFailure(error.value))
  }
  return Effect.succeed(freeze(migrations))
}

const decodeHistory = (raw: unknown) =>
  pipe(
    Schema.decodeUnknownEffect(SqliteMigrationHistorySchema)(raw),
    Effect.flatMap(validateDecodedHistory),
  )

const manifestEntryIsSafe = (entry: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(entry) && !entry.includes("..")

const manifestDirectory = (path: string) => {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return separator < 0 ? "." : path.slice(0, separator)
}

const manifestArtifactPath = (manifest: string, entry: string) =>
  `${manifestDirectory(manifest)}/${entry}`

interface LoadedSqliteMigrationManifest {
  readonly entries: ReadonlyArray<string>
  readonly migrations: ReadonlyArray<SqliteMigration>
}

const decodeManifestEntries = (source: string) =>
  pipe(
    Schema.decodeUnknownEffect(SqliteMigrationManifestSourceSchema)(source),
    Effect.mapError((cause) => migrationFailure("invalid SQLite migration manifest", cause)),
    Effect.flatMap(({ migrations }) => {
      const invalid = Array.some(migrations, (entry) => !manifestEntryIsSafe(entry))
      const unique = new Set(migrations)
      const hasDuplicates = unique.size !== migrations.length
      if (invalid || hasDuplicates) {
        return Effect.fail(
          migrationFailure(
            "SQLite migration manifest entries must be unique relative JSON artifact names",
          ),
        )
      }
      return Effect.succeed(freeze(migrations))
    }),
  )

const readMigrationManifest = Effect.fn("SqliteMigrations.readMigrationManifest")(
  function* (manifest: string) {
    const fileSystem = yield* FileSystem.FileSystem
    const source = yield* pipe(
      fileSystem.readFileString(manifest),
      Effect.mapError((cause) => migrationFailure("could not read SQLite migration manifest", cause)),
    )
    const entries = yield* decodeManifestEntries(source)
    const migrations = yield* Effect.forEach(entries, (entry) =>
      pipe(
        fileSystem.readFileString(manifestArtifactPath(manifest, entry)),
        Effect.mapError((cause) =>
          migrationFailure(`could not read SQLite migration artifact ${entry}`, cause),
        ),
        Effect.flatMap(decodeMigration),
      ))
    return {
      entries,
      migrations: yield* validateDecodedHistory(migrations),
    } satisfies LoadedSqliteMigrationManifest
  },
)

const loadHistory = (manifest: string) =>
  pipe(readMigrationManifest(manifest), Effect.map((loaded) => loaded.migrations))

const history = (raw: unknown): ReadonlyArray<SqliteMigration> =>
  Effect.runSync(decodeHistory(raw))


const parseSqliteRename = (input: string) => {
  const parts = input.split(":")
  const first = Array.get(parts, 0)
  const second = Array.get(parts, 1)
  const third = Array.get(parts, 2)
  const values = Option.all([first, second, third])
  const hasExpectedPartCount = Equivalence.strictEqual<number>()(parts.length, 3)

  const makeRename = ([table, from, to]: readonly [string, string, string]) => {
    if (!hasExpectedPartCount) {
      return Option.none<SqliteRename>()
    }
    const rename = SqliteRename.make({ table, from, to })
    const frozenRename = freeze(rename)
    return Option.some(frozenRename)
  }

  return Option.flatMap(values, makeRename)
}

const MigrationValueSourceSchema = Schema.fromJsonString(MigrationValueSchema)

const parseSqliteBackfill = (input: string) => {
  const first = input.indexOf(":")
  const second = input.indexOf(":", first + 1)
  const hasMissingTable = first <= 0
  const hasMissingColumn = second <= first + 1
  const malformed = hasMissingTable || hasMissingColumn
  if (malformed) {
    const none = Option.none<SqliteBackfill>()
    return Effect.succeed(none)
  }

  const valueSource = input.slice(second + 1)
  const table = input.slice(0, first)
  const column = input.slice(first + 1, second)

  const makeBackfill = (value: MigrationValue) => {
    const backfill = SqliteBackfill.make({ table, column, value })
    const frozenBackfill = freeze(backfill)
    return Option.some(frozenBackfill)
  }

  const noBackfill = Option.none<SqliteBackfill>()
  const noBackfillEffect = Effect.succeed(noBackfill)
  const recoverNoBackfill = Function.constant(noBackfillEffect)
  return pipe(
    Schema.decodeUnknownEffect(MigrationValueSourceSchema)(valueSource),
    Effect.map(makeBackfill),
    Effect.catch(recoverNoBackfill),
  )
}

const parseSqliteTransform = (input: string) => {
  const first = input.indexOf(":")
  const second = input.indexOf(":", first + 1)
  const hasMissingTable = first <= 0
  const hasMissingColumn = second <= first + 1
  const malformed = hasMissingTable || hasMissingColumn
  if (malformed) {
    return Option.none<SqliteTransform>()
  }

  const table = input.slice(0, first)
  const column = input.slice(first + 1, second)
  const expression = input.slice(second + 1)
  const transform = SqliteTransform.make({ table, column, expression })
  const frozenTransform = freeze(transform)
  return sqlExpressionIsValid(frozenTransform.expression)
    ? Option.some(frozenTransform)
    : Option.none()
}

const writeJson = Effect.fn("SqliteMigrations.writeJson")(function* (
  value: unknown,
  out: Option.Option<string>,
) {
  const canonicalValue = canonical(value)
  const output = `${JSON.stringify(canonicalValue, null, 2)}\n`
  if (Option.isSome(out)) {
    const fileSystem = yield* FileSystem.FileSystem
    return yield* fileSystem.writeFileString(out.value, output)
  }

  const stdio = yield* Stdio.Stdio
  const stream = Stream.make(output)
  const stdout = stdio.stdout()
  return yield* Stream.run(stream, stdout)
})

type FieldPlan = Readonly<{
  target: TableField
  rename: Option.Option<SqliteRename>
  transform: Option.Option<SqliteTransform>
  backfill: Option.Option<SqliteBackfill>
  sourceField: Option.Option<TableField>
  expression: Option.Option<string>
  errors: ReadonlyArray<string>
}>

const planSqliteMigration = (input: Parameters<typeof SqliteMigrationPlanOptions.make>[0]) => {
  const options = SqliteMigrationPlanOptions.make(input)
  const { renames, backfills, transforms } = options
  const fromTables = tableMap(options.from)
  const toTables = tableMap(options.to)
  const renameKey = (rename: SqliteRename) => `${rename.table}\u0000${rename.to}`
  const backfillKey = (backfill: SqliteBackfill) => `${backfill.table}\u0000${backfill.column}`
  const transformKey = (transform: SqliteTransform) => `${transform.table}\u0000${transform.column}`
  const renamesByTarget = intentMap(renames, renameKey)
  const backfillsByColumn = intentMap(backfills, backfillKey)
  const transformsByColumn = intentMap(transforms, transformKey)

  const planTable = (target: TableSnapshot) => Option.match(HashMap.get(fromTables, target.name), {
    onNone: () => ({
      steps: [freeze(SqliteCreateTable.make({ table: target }))],
      errors: [],
      usedRenames: new Set<SqliteRename>(),
      usedBackfills: new Set<SqliteBackfill>(),
      usedTransforms: new Set<SqliteTransform>(),
    }),
    onSome: (source) => {
      const sourceFields = fieldMap(source)
      const fieldPlans: ReadonlyArray<FieldPlan> = Array.map(target.fields, (targetField) => {
        const key = `${target.name}\u0000${targetField.name}`
        const rename = HashMap.get(renamesByTarget, key)
        const transform = HashMap.get(transformsByColumn, key)
        const backfill = HashMap.get(backfillsByColumn, key)
        const sourceName = Option.isSome(rename) ? rename.value.from : targetField.name
        const sourceField = HashMap.get(sourceFields, sourceName)
        const expression = Option.isSome(transform) && sqlExpressionIsValid(transform.value.expression)
          ? Option.some(transform.value.expression)
          : Option.none<string>()
        const errors: Array<string> = []
        if (
          Option.isSome(sourceField) &&
          !normalizedFieldEquals(sourceField.value, targetField) &&
          Option.isNone(expression)
        ) {
          errors.push(`field ${target.name}.${targetField.name} changes storage metadata without a transform`)
        }
        if (
          Option.isNone(sourceField) &&
          !targetField.nullable &&
          Option.isNone(expression) &&
          Option.isNone(backfill)
        ) {
          errors.push(`field ${target.name}.${targetField.name} requires an explicit backfill or transform`)
        }
        return { target: targetField, rename, transform, backfill, sourceField, expression, errors }
      })

      const retainedSources = new Set(
        Array.getSomes(Array.map(fieldPlans, (fieldPlan) =>
          Option.isSome(fieldPlan.sourceField) ? Option.some(fieldPlan.sourceField.value.name) : Option.none<string>())),
      )
      const retainedErrors = Array.flatMap(source.fields, (sourceField) =>
        retainedSources.has(sourceField.name)
          ? []
          : [`field ${target.name}.${sourceField.name} would be dropped or renamed without intent`])
      const rebuild = Array.some(fieldPlans, (fieldPlan) =>
        Option.isSome(fieldPlan.expression) ||
        (Option.isNone(fieldPlan.sourceField) && Option.isSome(fieldPlan.backfill)))
      const usedRenames = new Set(
        Array.getSomes(Array.map(fieldPlans, (fieldPlan) => fieldPlan.rename)),
      )
      const usedTransforms = new Set(
        Array.getSomes(Array.map(fieldPlans, (fieldPlan) =>
          Option.isSome(fieldPlan.expression) ? fieldPlan.transform : Option.none<SqliteTransform>())),
      )
      const usedBackfills = rebuild
        ? new Set(
          Array.getSomes(Array.map(fieldPlans, (fieldPlan) =>
            Option.isNone(fieldPlan.sourceField) && Option.isNone(fieldPlan.expression)
              ? fieldPlan.backfill
              : Option.none<SqliteBackfill>())),
        )
        : new Set<SqliteBackfill>()
      const copy = (
        fieldPlan: FieldPlan,
      ): ReadonlyArray<SqliteColumnSource | SqliteColumnValue | SqliteColumnExpression> => {
        if (Option.isSome(fieldPlan.expression)) {
          return [freeze(SqliteColumnExpression.make({
            column: fieldPlan.target.name,
            expression: fieldPlan.expression.value,
          }))]
        }
        if (Option.isSome(fieldPlan.sourceField)) {
          return [freeze(SqliteColumnSource.make({
            column: fieldPlan.target.name,
            source: fieldPlan.sourceField.value.name,
          }))]
        }
        return Option.isSome(fieldPlan.backfill)
          ? [freeze(SqliteColumnValue.make({
            column: fieldPlan.target.name,
            value: fieldPlan.backfill.value.value,
          }))]
          : []
      }
      const directSteps = (fieldPlan: FieldPlan): ReadonlyArray<SqliteMigrationStep> => {
        if (Option.isNone(fieldPlan.sourceField)) {
          return fieldPlan.target.nullable
            ? [freeze(SqliteAddColumn.make({ table: target.name, column: fieldPlan.target }))]
            : []
        }
        return fieldPlan.sourceField.value.name === fieldPlan.target.name
          ? []
          : [freeze(SqliteRenameColumn.make({
            table: target.name,
            from: fieldPlan.sourceField.value.name,
            to: fieldPlan.target.name,
          }))]
      }
      const steps = rebuild
        ? [freeze(SqliteRebuildTable.make({ table: target, copies: Array.flatMap(fieldPlans, copy) }))]
        : Array.flatMap(fieldPlans, directSteps)
      const errors = [
        ...(source.identifier === target.identifier ? [] : [`table ${target.name} changes its identifier`]),
        ...Array.flatMap(fieldPlans, (fieldPlan) => fieldPlan.errors),
        ...retainedErrors,
      ]
      return { steps, errors, usedRenames, usedBackfills, usedTransforms }
    },
  })

  const tablePlans = Array.map(options.to.tables, planTable)
  const usedRenames = new Set(Array.flatMap(tablePlans, (plan) => [...plan.usedRenames]))
  const usedBackfills = new Set(Array.flatMap(tablePlans, (plan) => [...plan.usedBackfills]))
  const usedTransforms = new Set(Array.flatMap(tablePlans, (plan) => [...plan.usedTransforms]))
  const duplicateRenameKeys = duplicateIntentKeys(renames, renameKey)
  const duplicateBackfillKeys = duplicateIntentKeys(backfills, backfillKey)
  const duplicateTransformKeys = duplicateIntentKeys(transforms, transformKey)
  const intentErrors = [
    ...identifiers(options.from),
    ...identifiers(options.to),
    ...Array.map(duplicateRenameKeys, (key) => `duplicate rename intent for ${key.replace("\u0000", ".")}`),
    ...Array.map(duplicateBackfillKeys, (key) => `duplicate backfill intent for ${key.replace("\u0000", ".")}`),
    ...Array.map(duplicateTransformKeys, (key) => `duplicate transform intent for ${key.replace("\u0000", ".")}`),
  ]
  const validationErrors = [
    ...(options.id.length === 0 ? ["migration id must not be empty"] : []),
    ...Array.flatMap(transforms, (transform) =>
      sqlExpressionIsValid(transform.expression)
        ? []
        : [`transform ${transform.table}.${transform.column} must be one SQL expression without comments or semicolons`]),
    ...Array.flatMap(options.from.tables, (table) =>
      HashMap.has(toTables, table.name) ? [] : [`table ${table.name} would be dropped`]),
    ...Array.flatMap(renames, (rename) =>
      usedRenames.has(rename) ? [] : [`unused rename intent for ${rename.table}.${rename.from}`]),
    ...Array.flatMap(backfills, (backfill) =>
      usedBackfills.has(backfill) ? [] : [`unused backfill intent for ${backfill.table}.${backfill.column}`]),
    ...Array.flatMap(transforms, (transform) =>
      usedTransforms.has(transform) ? [] : [`unused transform intent for ${transform.table}.${transform.column}`]),
  ]
  const errors = [...intentErrors, ...validationErrors, ...Array.flatMap(tablePlans, (plan) => plan.errors)]
  const steps = [
    ...Array.flatMap(tablePlans, (plan) => plan.steps),
    ...Array.map(errors, blocked),
  ]
  return freeze(SqliteMigration.make({
    id: options.id,
    from: options.from,
    to: options.to,
    steps,
  }))
}

type SqliteMigrationsCommandOptions = Readonly<{
  name: string
  tables: ReadonlyArray<Table>
  migrations?: ReadonlyArray<SqliteMigration>
  manifest?: string
}>

const sqliteMigrationsCommand = (options: SqliteMigrationsCommandOptions) => {
  const outFlag = Flag.file("out")
  const out = Flag.optional(outFlag)

  const snapshotCommand = Effect.fn("SqliteMigrations.snapshotCommand")(function* ({ out }) {
    const snapshot = snapshotFromTable(options.tables)
    return yield* writeJson(encodeSnapshot(snapshot), out)
  })

  const snapshot = Command.make("snapshot", { out }, snapshotCommand)
  const fromFlag = Flag.file("from")
  const from = Flag.optional(fromFlag)
  const id = Flag.string("id")
  const renameFlag = Flag.string("rename")
  const rename = Flag.optional(renameFlag)
  const backfillFlag = Flag.string("backfill")
  const backfill = Flag.optional(backfillFlag)
  const transformFlag = Flag.string("transform")

  const describedTransform = Flag.withDescription(
    transformFlag,
    "table:column:SQL-expression; the expression reads physical --from columns before renames",
  )
  const transform = Flag.optional(describedTransform)

  const artifactFromIntents = Effect.fn("SqliteMigrations.artifactFromIntents")(function* (
    input: Readonly<{
      id: string
      from: SqliteSchemaSnapshot
      rename: Option.Option<string>
      backfill: Option.Option<string>
      transform: Option.Option<string>
    }>,
  ) {
    const renameIntent = Option.flatMap(input.rename, parseSqliteRename)
    const noBackfill = Option.none<SqliteBackfill>()
    const backfillIntent = yield* Option.match(input.backfill, {
      onNone: Function.constant(Effect.succeed(noBackfill)),
      onSome: parseSqliteBackfill,
    })
    const transformIntent = Option.flatMap(input.transform, parseSqliteTransform)
    const invalidRenameIntent = Option.isNone(renameIntent)
    const invalidBackfillIntent = Option.isNone(backfillIntent)
    const invalidTransformIntent = Option.isNone(transformIntent)
    const invalidRename = Option.match(input.rename, {
      onNone: Function.constFalse,
      onSome: Function.constant(invalidRenameIntent),
    })
    const invalidBackfill = Option.match(input.backfill, {
      onNone: Function.constFalse,
      onSome: Function.constant(invalidBackfillIntent),
    })
    const invalidTransform = Option.match(input.transform, {
      onNone: Function.constFalse,
      onSome: Function.constant(invalidTransformIntent),
    })
    if (invalidRename || invalidBackfill || invalidTransform) {
      return yield* CliError.UserError.make({
        cause: migrationFailure("invalid migration intent"),
        userMessage: "--rename is table:from:to, --backfill is table:column:JSON-value, and --transform is table:column:SQL-expression",
      })
    }

    const valuesFromOption = <A>(value: Option.Option<A>) =>
      Option.match(value, {
        onNone: Function.constant([]),
        onSome: (item) => [item],
      })

    return planSqliteMigration({
      id: input.id,
      from: input.from,
      to: snapshotFromTable(options.tables),
      renames: valuesFromOption(renameIntent),
      backfills: valuesFromOption(backfillIntent),
      transforms: valuesFromOption(transformIntent),
    })
  })

  const readPrevious = Effect.fn("SqliteMigrations.readPrevious")(function* (path: string) {
    const fileSystem = yield* FileSystem.FileSystem
    const source = yield* pipe(
      fileSystem.readFileString(path),
      Effect.mapError((cause) => CliError.UserError.make({
        cause,
        userMessage: "Could not read --from snapshot or migration artifact",
      })),
    )
    return yield* pipe(
      decodeSource(source),
      Effect.mapError((cause) => CliError.UserError.make({
        cause,
        userMessage: "Could not decode --from snapshot or migration artifact",
      })),
    )
  })

  const unresolvedMessage = (artifact: SqliteMigration) =>
    ["Migration plan contains unresolved changes", ...artifact.steps
      .filter(Schema.is(SqliteBlockedChange))
      .map((step) => step.reason)].join("\n")

  const planCommand = Effect.fn("SqliteMigrations.planCommand")(function* (
    { from, id, rename, backfill, transform, out },
  ) {
    const previous = yield* Option.match(from, {
      onNone: Function.constant(Effect.succeed(emptySnapshot())),
      onSome: readPrevious,
    })
    const artifact = yield* artifactFromIntents({
      id,
      from: previous,
      rename,
      backfill,
      transform,
    })
    yield* writeJson(encodeMigration(artifact), out)
    const hasBlockedChange = Array.some(artifact.steps, Schema.is(SqliteBlockedChange))
    if (hasBlockedChange) {
      return yield* CliError.UserError.make({
        cause: artifact,
        userMessage: unresolvedMessage(artifact),
      })
    }
  })

  const plan = Command.make(
    "plan",
    { from, id, rename, backfill, transform, out },
    planCommand,
  )

  const generateName = Argument.string("name")

  const registeredManifest = Effect.fn("SqliteMigrations.registeredManifest")(function* (
    manifest: string,
  ) {
    const loaded = yield* pipe(
      readMigrationManifest(manifest),
      Effect.mapError((cause) => CliError.UserError.make({
        cause,
        userMessage: "Could not load the registered SQLite migration manifest",
      })),
    )
    if (options.migrations !== undefined) {
      const configured = yield* pipe(
        validateDecodedHistory(options.migrations),
        Effect.mapError((cause) => CliError.UserError.make({
          cause,
          userMessage: "Configured SQLite migration history is invalid",
        })),
      )
      if (!same(configured, loaded.migrations)) {
        return yield* CliError.UserError.make({
          cause: migrationFailure("configured history differs from manifest history"),
          userMessage: "Configured SQLite migration history must match the ordered manifest",
        })
      }
    }
    return loaded
  })

  const generateCommand = Effect.fn("SqliteMigrations.generateCommand")(function* (
    input: Readonly<{
      name: string
      rename: Option.Option<string>
      backfill: Option.Option<string>
      transform: Option.Option<string>
    }>,
  ) {
    const { name, rename, backfill, transform } = input
    if (options.manifest === undefined) {
      return yield* CliError.UserError.make({
        cause: migrationFailure("missing SQLite migration manifest"),
        userMessage: "generate requires a configured migration manifest",
      })
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      return yield* CliError.UserError.make({
        cause: migrationFailure("invalid migration name"),
        userMessage: "migration name must contain only letters, numbers, underscores, or hyphens",
      })
    }

    const manifest = options.manifest
    const loaded = yield* registeredManifest(manifest)
    const last = Array.get(loaded.migrations, loaded.migrations.length - 1)
    const previous = Option.match(last, {
      onNone: emptySnapshot,
      onSome: migrationTo,
    })
    const lastId = Option.map(last, (migration) => migration.id)
    const numericPrefix = Option.flatMap(lastId, (value) => {
      const match = /^(\d+)_/.exec(value)
      const prefix = match === null ? undefined : match[1]
      return prefix === undefined ? Option.none<string>() : Option.some(prefix)
    })
    const nextNumber = Option.match(numericPrefix, {
      onNone: Function.constant("001"),
      onSome: (prefix) => {
        const value = Number(prefix)
        return Number.isSafeInteger(value)
          ? String(value + 1).padStart(prefix.length, "0")
          : ""
      },
    })
    if (nextNumber.length === 0) {
      return yield* CliError.UserError.make({
        cause: migrationFailure("invalid final SQLite migration id"),
        userMessage: "the final registered migration id must have a safe numeric prefix",
      })
    }

    const id = `${nextNumber}_${name}`
    const entry = `${id}.json`
    const artifactPath = manifestArtifactPath(manifest, entry)
    const fileSystem = yield* FileSystem.FileSystem
    const artifactExists = yield* fileSystem.exists(artifactPath)
    if (artifactExists || Array.contains(loaded.entries, entry)) {
      return yield* CliError.UserError.make({
        cause: migrationFailure("SQLite migration artifact path collision"),
        userMessage: `Migration artifact already exists: ${entry}`,
      })
    }

    const artifact = yield* artifactFromIntents({
      id,
      from: previous,
      rename,
      backfill,
      transform,
    })
    const hasBlockedChange = Array.some(artifact.steps, Schema.is(SqliteBlockedChange))
    if (hasBlockedChange) {
      return yield* CliError.UserError.make({
        cause: artifact,
        userMessage: unresolvedMessage(artifact),
      })
    }
    yield* pipe(
      validateDecodedHistory(Array.append(loaded.migrations, artifact)),
      Effect.mapError((cause) => CliError.UserError.make({
        cause,
        userMessage: "Generated migration would make the registered history invalid",
      })),
    )

    const artifactText = `${JSON.stringify(canonical(encodeMigration(artifact)), null, 2)}\n`
    const manifestText = `${JSON.stringify(
      canonical({ migrations: Array.append(loaded.entries, entry) }),
      null,
      2,
    )}\n`
    yield* fileSystem.writeFileString(artifactPath, artifactText, { flag: "wx" })
    const temporaryManifest = yield* fileSystem.makeTempFile({
      directory: manifestDirectory(manifest),
      prefix: ".effect-domains-migrations-",
    })
    yield* fileSystem.writeFileString(temporaryManifest, manifestText)
    yield* fileSystem.rename(temporaryManifest, manifest)
  })

  const generate = Command.make(
    "generate",
    { name: generateName, rename, backfill, transform },
    generateCommand,
  )
  const command = Command.make(options.name)
  return Command.withSubcommands(command, [snapshot, plan, generate])
}

export const SqliteMigrations = {
  snapshot: snapshotFromTable,
  plan: planSqliteMigration,
  history,
  load: loadHistory,
  command: sqliteMigrationsCommand,
}

export const makeMigrationStore = (
  sql: SqlClient.SqlClient,
  migrations: ReadonlyArray<SqliteMigration>,
) =>
  SchemaStore.of({
    prepare: Effect.fn("SchemaStore.prepare")(function* (tables) {
      const target = schemaSnapshot(tables)
      const historyError = validateHistory(migrations)
      if (Option.isSome(historyError)) {
        return yield* migrationFailure(historyError.value)
      }

      const lastMigration = Array.get(migrations, migrations.length - 1)
      const expectedTarget = Option.match(lastMigration, {
        onNone: emptySnapshot,
        onSome: migrationTo,
      })
      if (migrations.length === 0 && target.tables.length > 0) {
        return yield* migrationFailure("nonempty application schemas require an initial migration history")
      }
      if (!same(expectedTarget, target)) {
        return yield* migrationFailure("the frozen migration history does not end at the application schema")
      }

      yield* ensureMetadata(sql)
      const ledger = yield* recordedMigrations(sql)
      if (ledger.length > migrations.length) {
        return yield* migrationFailure("SQLite contains migration history not supplied by the application")
      }

      const changedMigration = Array.findFirst(Array.zip(ledger, migrations), ([recorded, supplied]) =>
        recorded.id !== supplied.id || recorded.artifact !== canonicalText(supplied))
      if (Option.isSome(changedMigration)) {
        return yield* migrationFailure(`migration history changed at ${changedMigration.value[0].id}`)
      }

      const previousMigration = Array.get(migrations, ledger.length - 1)
      const expectedCurrent = ledger.length === 0
        ? emptySnapshot()
        : Option.match(previousMigration, { onNone: emptySnapshot, onSome: migrationTo })
      yield* verifyDatabase(sql, expectedCurrent)

      const applyPendingMigration = (migration: SqliteMigration, index: number) =>
        applyMigration(sql, migration, index + ledger.length)
      yield* Effect.forEach(Array.drop(migrations, ledger.length), applyPendingMigration, { discard: true })
      return yield* verifyDatabase(sql, target)
    }),
  })
