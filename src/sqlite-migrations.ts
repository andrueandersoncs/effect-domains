import { Array, Effect, Equivalence, FileSystem, flow, Function, HashMap, HashSet, Match, Option, Order, pipe, Predicate, Record, Schema, Stdio, Stream, Struct } from "effect"
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
  const initial = [HashSet.empty<string>(), [] as ReadonlyArray<string>] as const

  const appendDuplicate = (
    [seen, duplicates]: readonly [HashSet.HashSet<string>, ReadonlyArray<string>],
    value: A,
  ) => {
    const valueKey = key(value)
    const hasDuplicate = HashSet.has(seen, valueKey)
    const nextDuplicates = hasDuplicate ? Array.append(duplicates, valueKey) : duplicates
    const nextSeen = HashSet.add(seen, valueKey)
    return [nextSeen, nextDuplicates] as const
  }

  const [, duplicates] = Array.reduce(values, initial, appendDuplicate)
  return duplicates
}

const identifiers = (snapshot: SqliteSchemaSnapshot): ReadonlyArray<string> => {
  const validateTable = (
    [tableNames, allErrors]: readonly [HashSet.HashSet<string>, ReadonlyArray<string>],
    table: TableSnapshot,
  ) => {
    const initialFieldNames = HashSet.empty<string>()
    const initialFieldErrors: ReadonlyArray<string> = []
    const initialFieldValidation = [initialFieldNames, initialFieldErrors] as const

    const [fieldNames, fieldErrors] = Array.reduce(
      table.fields,
      initialFieldValidation,
      ([names, errors], field) => {
        const emptyName = Equivalence.strictEqual<number>()(field.name.length, 0)
        const duplicateName = HashSet.has(names, field.name)

        const emptyErrors = emptyName
          ? Array.append(errors, `table ${table.name} contains an empty field name`)
          : errors

        const nextErrors = duplicateName
          ? Array.append(emptyErrors, `table ${table.name} contains field ${field.name} more than once`)
          : emptyErrors

        return [HashSet.add(names, field.name), nextErrors] as const
      },
    )

    const emptyTableName = Equivalence.strictEqual<number>()(table.name.length, 0)
    const emptyIdentifier = Equivalence.strictEqual<number>()(table.identifier.length, 0)
    const hasEmptyTableMetadata = emptyTableName || emptyIdentifier
    const duplicateTableName = HashSet.has(tableNames, table.name)

    const tableMetadataErrors = hasEmptyTableMetadata
      ? Array.append(allErrors, "table names and identifiers must not be empty")
      : allErrors

    const tableErrors = duplicateTableName
      ? Array.append(tableMetadataErrors, `table ${table.name} occurs more than once`)
      : tableMetadataErrors

    const errorsWithFields = Array.appendAll(tableErrors, fieldErrors)
    const hasIdentifierField = HashSet.has(fieldNames, table.identifier)

    const nextErrors = hasIdentifierField
      ? errorsWithFields
      : Array.append(errorsWithFields, `table ${table.name} has no identifier field ${table.identifier}`)

    return [HashSet.add(tableNames, table.name), nextErrors] as const
  }

  const initial = [HashSet.empty<string>(), [] as ReadonlyArray<string>] as const
  const [, errors] = Array.reduce(snapshot.tables, initial, validateTable)
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

const migrationFailure = (reason: string, cause: unknown = undefined): MigrationError => {
  const firstCause = Option.fromUndefinedOr(cause)
  const failureWithoutCause = MigrationError.make({ reason })
  return Option.match(firstCause, {
    onNone: Function.constant(failureWithoutCause),
    onSome: (value) => MigrationError.make({ reason, cause: value }),
  })
}

const SqliteSnapshotJsonSchema = Schema.toCodecJson(SqliteSchemaSnapshot)
const SqliteSnapshotSourceSchema = Schema.fromJsonString(SqliteSnapshotJsonSchema)
const SqliteMigrationJsonSchema = Schema.toCodecJson(SqliteMigration)
const SqliteMigrationSourceSchema = Schema.fromJsonString(SqliteMigrationJsonSchema)

const encodeSnapshot = Schema.encodeUnknownSync(SqliteSnapshotJsonSchema)
const encodeMigration = Schema.encodeUnknownSync(SqliteMigrationJsonSchema)

const SqliteMigrationHistorySchema = Schema.Array(SqliteMigrationJsonSchema)

const SqliteMigrationManifestEntriesSchema = Schema.Array(Schema.String)

class SqliteMigrationManifest extends Schema.Class<SqliteMigrationManifest>(
  "SqliteMigrationManifest",
)({
  migrations: SqliteMigrationManifestEntriesSchema,
}) {}

const SqliteMigrationManifestSourceSchema = Schema.fromJsonString(
  SqliteMigrationManifest,
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

const sqlExpressionIsValid = (expression: string) => {
  const trimmedExpression = expression.trim()
  const hasContent = trimmedExpression.length > 0

  const invalidityFlags = [
    expression.includes("\u0000"),
    expression.includes(";"),
    expression.includes("--"),
    expression.includes("/*"),
  ]

  const hasForbiddenSyntax = Array.some(invalidityFlags, Boolean)
  const validityFlags = [hasContent, !hasForbiddenSyntax]
  return Array.every(validityFlags, Boolean)
}


const applyStatement = (sql: SqlClient.SqlClient, statement: string) =>
  pipe(
    sql`${sql.literal(statement)}`,
    Effect.asVoid,
    Effect.mapError((cause) => migrationFailure("SQLite schema operation failed", cause)),
  )

const ensureMetadata = (sql: SqlClient.SqlClient) => {
  const ledgerTable = quote(LedgerTable)
  const createLedger = `CREATE TABLE IF NOT EXISTS ${ledgerTable} (position INTEGER PRIMARY KEY NOT NULL, id TEXT UNIQUE NOT NULL, artifact TEXT NOT NULL)`
  return applyStatement(sql, createLedger)
}

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

const untrackedTableObjects = (sql: SqlClient.SqlClient, table: string) => {
  const objectNames = (rows: ReadonlyArray<SqliteTableObjectRow>) =>
    Array.map(rows, (row) => `${row.name}`)

  const decoder = Schema.decodeUnknownEffect(SqliteTableObjectRowsSchema)
  return pipe(
    sql`SELECT name FROM sqlite_master
      WHERE tbl_name = ${table} AND type IN ('index', 'trigger')
        AND name NOT LIKE 'sqlite_autoindex_%'`,
    Effect.flatMap(decoder),
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
  const decoder = Schema.decodeUnknownEffect(SqliteMigrationRowsSchema)

  return pipe(
    sql`SELECT id, artifact FROM ${ledger} ORDER BY position`,
    Effect.flatMap(decoder),
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
  const decoder = Schema.decodeUnknownEffect(SqliteTableObjectRowsSchema)

  const namesFromSqlitetableobjectrow = (rows: ReadonlyArray<SqliteTableObjectRow>) =>
    Array.map(rows, (sqliteTableObjectRow) => `${sqliteTableObjectRow.name}`)

  return pipe(
    sql`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        AND name NOT IN (${LedgerTable})
      ORDER BY name`,
    Effect.flatMap(decoder),
    Effect.map(namesFromSqlitetableobjectrow),
    Effect.mapError((cause) => migrationFailure("could not inspect SQLite schema", cause)),
  )
}

const tableSql = (sql: SqlClient.SqlClient, name: string) => {
  const decoder = Schema.decodeUnknownEffect(SqliteTableSqlRowsSchema)

  const firstRowSql = (rows: ReadonlyArray<SqliteTableSqlRow>) => {
    const first = Array.head(rows)
    return Option.match(first, {
      onNone: Function.constant(null),
      onSome: (sqliteTableSqlRow) => `${sqliteTableSqlRow.sql}`,
    })
  }

  return pipe(
    sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${name}`,
    Effect.flatMap(decoder),
    Effect.map(firstRowSql),
    Effect.mapError((cause) => migrationFailure(`could not inspect table ${name}`, cause)),
  )
}

const verifyDatabase = Effect.fn("SqliteMigrations.verifyDatabase")(function* (
  sql: SqlClient.SqlClient,
  snapshot: SqliteSchemaSnapshot,
) {
  const decodeColumns = Schema.decodeUnknownEffect(SqliteTableObjectRowsSchema)
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
      Effect.flatMap(decodeColumns),
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

const validateDecodedMigrations = (
  migrations: ReadonlyArray<SqliteMigration>,
): Effect.Effect<ReadonlyArray<SqliteMigration>, MigrationError> => {
  const error = validateHistory(migrations)
  const frozenMigrations = freeze(migrations)
  const successfulMigrations = Effect.succeed(frozenMigrations)
  const failedMigrations = flow(migrationFailure, Effect.fail)

  return Option.match(error, {
    onNone: Function.constant(successfulMigrations),
    onSome: failedMigrations,
  })
}

const decodeHistory = (raw: unknown) =>
  pipe(
    Schema.decodeUnknownEffect(SqliteMigrationHistorySchema)(raw),
    Effect.flatMap(validateDecodedMigrations),
  )

const manifestEntryIsSafe = (entry: string) => {
  const isJsonArtifact = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(entry)
  const containsParentTraversal = entry.includes("..")
  const safetyFlags = [isJsonArtifact, !containsParentTraversal]
  return Array.every(safetyFlags, Boolean)
}

const manifestDirectory = (path: string) => {
  const unixSeparator = path.lastIndexOf("/")
  const windowsSeparator = path.lastIndexOf("\\")
  const separator = Math.max(unixSeparator, windowsSeparator)
  return separator < 0 ? "." : path.slice(0, separator)
}

const manifestArtifactPath = (manifest: string, entry: string) =>
  `${manifestDirectory(manifest)}/${entry}`

const ManifestEntriesSchema = Schema.Array(Schema.String)
const SqliteMigrationsArraySchema = Schema.Array(SqliteMigration)

class LoadedSqliteMigrationManifest extends Schema.Class<LoadedSqliteMigrationManifest>(
  "LoadedSqliteMigrationManifest",
)({
  entries: ManifestEntriesSchema,
  migrations: SqliteMigrationsArraySchema,
}) {}

const isUnsafeManifestEntry = Predicate.not(manifestEntryIsSafe)

const decodeManifestEntries = (source: string) =>
  pipe(
    Schema.decodeUnknownEffect(SqliteMigrationManifestSourceSchema)(source),
    Effect.mapError((cause) => migrationFailure("invalid SQLite migration manifest", cause)),
    Effect.flatMap((manifest) => {
      const hasInvalidEntry = Array.some(manifest.migrations, isUnsafeManifestEntry)
      const uniqueEntries = HashSet.fromIterable(manifest.migrations)
      const uniqueEntryCount = HashSet.size(uniqueEntries)
      const hasDuplicates = !Equivalence.strictEqual<number>()(uniqueEntryCount, manifest.migrations.length)
      const invalidManifest = hasInvalidEntry || hasDuplicates
      if (invalidManifest) {
        const manifestError = migrationFailure(
          "SQLite migration manifest entries must be unique relative JSON artifact names",
        )

        return Effect.fail(manifestError)
      }
      const entries = freeze(manifest.migrations)
      return Effect.succeed(entries)
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

    const readArtifact = Effect.fn("SqliteMigrations.readArtifact")(function* (entry: string) {
      const artifactPath = manifestArtifactPath(manifest, entry)

      const source = yield* pipe(
        fileSystem.readFileString(artifactPath),
        Effect.mapError((cause) =>
          migrationFailure(`could not read SQLite migration artifact ${entry}`, cause),
        ),
      )

      return yield* decodeMigration(source)
    })

    const migrations = yield* Effect.forEach(entries, readArtifact)
    const validatedMigrations = yield* validateDecodedMigrations(migrations)

    const loadedManifest = LoadedSqliteMigrationManifest.make({
      entries,
      migrations: validatedMigrations,
    })

    return freeze(loadedManifest)
  },
)

const loadHistory = (manifest: string) =>
  pipe(readMigrationManifest(manifest), Effect.map(Struct.get("migrations")))

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

const SqliteRenameOptionSchema = Schema.Option(SqliteRename)
const SqliteTransformOptionSchema = Schema.Option(SqliteTransform)
const SqliteBackfillOptionSchema = Schema.Option(SqliteBackfill)
const TableFieldOptionSchema = Schema.Option(TableField)
const StringOptionSchema = Schema.Option(Schema.String)
const FieldPlanErrorsSchema = Schema.Array(Schema.String)
const TablePlanStepsSchema = Schema.Array(SqliteMigrationStepSchema)
const TablePlanErrorsSchema = Schema.Array(Schema.String)
const TablePlanRenamesSchema = Schema.Array(SqliteRename)
const TablePlanBackfillsSchema = Schema.Array(SqliteBackfill)
const TablePlanTransformsSchema = Schema.Array(SqliteTransform)

class FieldPlan extends Schema.Class<FieldPlan>("FieldPlan")({
  target: TableField,
  rename: SqliteRenameOptionSchema,
  transform: SqliteTransformOptionSchema,
  backfill: SqliteBackfillOptionSchema,
  sourceField: TableFieldOptionSchema,
  expression: StringOptionSchema,
  errors: FieldPlanErrorsSchema,
}) {}

class TablePlan extends Schema.Class<TablePlan>("TablePlan")({
  steps: TablePlanStepsSchema,
  errors: TablePlanErrorsSchema,
  usedRenames: TablePlanRenamesSchema,
  usedBackfills: TablePlanBackfillsSchema,
  usedTransforms: TablePlanTransformsSchema,
}) {}

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

  const planTable = (target: TableSnapshot) => {
    const sourceTable = HashMap.get(fromTables, target.name)

    const createTablePlan = () => {
      const createTable = SqliteCreateTable.make({ table: target })
      const step = freeze(createTable)
      return TablePlan.make({
        steps: [step],
        errors: [],
        usedRenames: [],
        usedBackfills: [],
        usedTransforms: [],
      })
    }

    const modifyTablePlan = (source: TableSnapshot) => {
      const sourceFields = fieldMap(source)

      const planField = (targetField: TableField) => {
        const key = `${target.name}\u0000${targetField.name}`
        const rename = HashMap.get(renamesByTarget, key)
        const transform = HashMap.get(transformsByColumn, key)
        const backfill = HashMap.get(backfillsByColumn, key)

        const sourceName = Option.match(rename, {
          onNone: Function.constant(targetField.name),
          onSome: Struct.get("from"),
        })

        const sourceField = HashMap.get(sourceFields, sourceName)

        const validTransform = Option.filter(
          transform,
          flow(Struct.get("expression"), sqlExpressionIsValid),
        )

        const expression = Option.map(validTransform, Struct.get("expression"))

        const sourceMetadataChanges = Option.match(sourceField, {
          onNone: Function.constFalse,
          onSome: (field) => !normalizedFieldEquals(field, targetField),
        })

        const hasNoExpression = Option.isNone(expression)
        const requiresTransform = sourceMetadataChanges && hasNoExpression

        const metadataErrors = requiresTransform
          ? [`field ${target.name}.${targetField.name} changes storage metadata without a transform`]
          : []

        const hasNoSource = Option.isNone(sourceField)
        const isRequiredField = !targetField.nullable
        const hasNoBackfill = Option.isNone(backfill)
        const requiredFieldFlags = [hasNoSource, isRequiredField, hasNoExpression, hasNoBackfill]
        const requiresBackfill = Array.every(requiredFieldFlags, Boolean)

        const backfillErrors = requiresBackfill
          ? [`field ${target.name}.${targetField.name} requires an explicit backfill or transform`]
          : []

        const errors = Array.appendAll(metadataErrors, backfillErrors)
        return FieldPlan.make({
          target: targetField,
          rename,
          transform,
          backfill,
          sourceField,
          expression,
          errors,
        })
      }

      const fieldPlans = Array.map(target.fields, planField)

      const sourceNameFromPlan = flow(
        Struct.get<FieldPlan, "sourceField">("sourceField"),
        Option.map(Struct.get<TableField, "name">("name")),
      )

      const sourceNameOptions = Array.map(fieldPlans, sourceNameFromPlan)
      const retainedSourceNames = Array.getSomes(sourceNameOptions)
      const retainedSources = HashSet.fromIterable(retainedSourceNames)

      const droppedSourceErrors = (sourceField: TableField) => {
        const isRetained = HashSet.has(retainedSources, sourceField.name)
        return isRetained
          ? []
          : [`field ${target.name}.${sourceField.name} would be dropped or renamed without intent`]
      }

      const retainedErrors = Array.flatMap(source.fields, droppedSourceErrors)

      const rebuildsTable = (fieldPlan: FieldPlan) => {
        const hasExpression = Option.isSome(fieldPlan.expression)
        const hasNoSource = Option.isNone(fieldPlan.sourceField)
        const hasBackfill = Option.isSome(fieldPlan.backfill)
        const rebuildsForBackfill = hasNoSource && hasBackfill
        return hasExpression || rebuildsForBackfill
      }

      const rebuild = Array.some(fieldPlans, rebuildsTable)
      const renameOptions = Array.map(fieldPlans, Struct.get("rename"))
      const usedRenames = Array.getSomes(renameOptions)

      const isTransformed = flow(
        Struct.get<FieldPlan, "expression">("expression"),
        Option.isSome,
      )

      const transformedIntent = Struct.get<FieldPlan, "transform">("transform")
      const transformedFieldPlans = Array.filter(fieldPlans, isTransformed)
      const transformIntents = Array.map(transformedFieldPlans, transformedIntent)
      const usedTransforms = Array.getSomes(transformIntents)

      const needsBackfill = (fieldPlan: FieldPlan) => {
        const hasNoSource = Option.isNone(fieldPlan.sourceField)
        const hasNoExpression = Option.isNone(fieldPlan.expression)
        return hasNoSource && hasNoExpression
      }

      const backfillFieldPlans = Array.filter(fieldPlans, needsBackfill)
      const backfillIntent = Struct.get<FieldPlan, "backfill">("backfill")
      const backfillIntents = Array.map(backfillFieldPlans, backfillIntent)
      const usedBackfills = rebuild ? Array.getSomes(backfillIntents) : []

      const copies = (
        fieldPlan: FieldPlan,
      ): ReadonlyArray<SqliteColumnSource | SqliteColumnValue | SqliteColumnExpression> =>
        Option.match(fieldPlan.expression, {
          onNone: () =>
            Option.match(fieldPlan.sourceField, {
              onNone: () =>
                Option.match(fieldPlan.backfill, {
                  onNone: Function.constant([]),
                  onSome: (backfill) => {

                    const value = SqliteColumnValue.make({
                      column: fieldPlan.target.name,
                      value: backfill.value,
                    })

                    return [freeze(value)]
                  },
                }),
              onSome: (source) => {

                const sourceCopy = SqliteColumnSource.make({
                  column: fieldPlan.target.name,
                  source: source.name,
                })

                return [freeze(sourceCopy)]
              },
            }),
          onSome: (expression) => {

            const expressionCopy = SqliteColumnExpression.make({
              column: fieldPlan.target.name,
              expression,
            })

            return [freeze(expressionCopy)]
          },
        })

      const directSteps = (fieldPlan: FieldPlan): ReadonlyArray<SqliteMigrationStep> =>
        Option.match(fieldPlan.sourceField, {
          onNone: () => {
            if (!fieldPlan.target.nullable) {
              return []
            }

            const addColumn = SqliteAddColumn.make({
              table: target.name,
              column: fieldPlan.target,
            })

            return [freeze(addColumn)]
          },
          onSome: (sourceField) => {
            const namesMatch = Equivalence.strictEqual<string>()(sourceField.name, fieldPlan.target.name)
            if (namesMatch) {
              return []
            }


            const renameColumn = SqliteRenameColumn.make({
              table: target.name,
              from: sourceField.name,
              to: fieldPlan.target.name,
            })

            return [freeze(renameColumn)]

          },
        })

      const directMigrationSteps = Array.flatMap(fieldPlans, directSteps)
      const copiesForRebuild = Array.flatMap(fieldPlans, copies)

      const rebuildTable = SqliteRebuildTable.make({
        table: target,
        copies: copiesForRebuild,
      })

      const steps = rebuild ? [freeze(rebuildTable)] : directMigrationSteps
      const identifiersMatch = Equivalence.strictEqual<string>()(source.identifier, target.identifier)
      const identifierErrors = identifiersMatch ? [] : [`table ${target.name} changes its identifier`]
      const fieldErrors = Array.flatMap(fieldPlans, Struct.get("errors"))
      const identityAndFieldErrors = Array.appendAll(identifierErrors, fieldErrors)
      const errors = Array.appendAll(identityAndFieldErrors, retainedErrors)

      return TablePlan.make({
        steps,
        errors,
        usedRenames,
        usedBackfills,
        usedTransforms,
      })

    }

    return Option.match(sourceTable, {
      onNone: createTablePlan,
      onSome: modifyTablePlan,
    })
  }

  const tablePlans = Array.map(options.to.tables, planTable)
  const renameIntents = Array.flatMap(tablePlans, Struct.get("usedRenames"))
  const backfillIntents = Array.flatMap(tablePlans, Struct.get("usedBackfills"))
  const transformIntents = Array.flatMap(tablePlans, Struct.get("usedTransforms"))
  const usedRenames = HashSet.fromIterable(renameIntents)
  const usedBackfills = HashSet.fromIterable(backfillIntents)
  const usedTransforms = HashSet.fromIterable(transformIntents)
  const duplicateRenameKeys = duplicateIntentKeys(renames, renameKey)
  const duplicateBackfillKeys = duplicateIntentKeys(backfills, backfillKey)
  const duplicateTransformKeys = duplicateIntentKeys(transforms, transformKey)
  const renameDuplicateError = (key: string) => `duplicate rename intent for ${key.replace("\u0000", ".")}`
  const backfillDuplicateError = (key: string) => `duplicate backfill intent for ${key.replace("\u0000", ".")}`
  const transformDuplicateError = (key: string) => `duplicate transform intent for ${key.replace("\u0000", ".")}`
  const inputIdentifierErrors = identifiers(options.from)
  const outputIdentifierErrors = identifiers(options.to)
  const identifierErrors = Array.appendAll(inputIdentifierErrors, outputIdentifierErrors)
  const renameDuplicateErrors = Array.map(duplicateRenameKeys, renameDuplicateError)
  const backfillDuplicateErrors = Array.map(duplicateBackfillKeys, backfillDuplicateError)
  const transformDuplicateErrors = Array.map(duplicateTransformKeys, transformDuplicateError)

  const renameAndBackfillDuplicateErrors = Array.appendAll(
    renameDuplicateErrors,
    backfillDuplicateErrors,
  )

  const duplicateErrors = Array.appendAll(renameAndBackfillDuplicateErrors, transformDuplicateErrors)
  const intentErrors = Array.appendAll(identifierErrors, duplicateErrors)
  const hasEmptyId = Equivalence.strictEqual<number>()(options.id.length, 0)
  const idErrors = hasEmptyId ? ["migration id must not be empty"] : []

  const invalidTransformError = (transform: SqliteTransform) =>
    sqlExpressionIsValid(transform.expression)
      ? []
      : [`transform ${transform.table}.${transform.column} must be one SQL expression without comments or semicolons`]

  const droppedTableError = (table: TableSnapshot) =>
    HashMap.has(toTables, table.name) ? [] : [`table ${table.name} would be dropped`]

  const unusedRenameError = (rename: SqliteRename) =>
    HashSet.has(usedRenames, rename) ? [] : [`unused rename intent for ${rename.table}.${rename.from}`]

  const unusedBackfillError = (backfill: SqliteBackfill) =>
    HashSet.has(usedBackfills, backfill) ? [] : [`unused backfill intent for ${backfill.table}.${backfill.column}`]

  const unusedTransformError = (transform: SqliteTransform) =>
    HashSet.has(usedTransforms, transform) ? [] : [`unused transform intent for ${transform.table}.${transform.column}`]

  const invalidTransformErrors = Array.flatMap(transforms, invalidTransformError)
  const droppedTableErrors = Array.flatMap(options.from.tables, droppedTableError)
  const unusedRenameErrors = Array.flatMap(renames, unusedRenameError)
  const unusedBackfillErrors = Array.flatMap(backfills, unusedBackfillError)
  const unusedTransformErrors = Array.flatMap(transforms, unusedTransformError)
  const idAndTransformErrors = Array.appendAll(idErrors, invalidTransformErrors)
  const validationPrefixErrors = Array.appendAll(idAndTransformErrors, droppedTableErrors)
  const unusedIntentErrors = Array.appendAll(unusedRenameErrors, unusedBackfillErrors)
  const allUnusedIntentErrors = Array.appendAll(unusedIntentErrors, unusedTransformErrors)
  const validationErrors = Array.appendAll(validationPrefixErrors, allUnusedIntentErrors)
  const tableErrors = Array.flatMap(tablePlans, Struct.get("errors"))
  const intentAndValidationErrors = Array.appendAll(intentErrors, validationErrors)
  const errors = Array.appendAll(intentAndValidationErrors, tableErrors)
  const migrationSteps = Array.flatMap(tablePlans, Struct.get("steps"))
  const blockedSteps = Array.map(errors, blocked)
  const steps = Array.appendAll(migrationSteps, blockedSteps)

  const migration = SqliteMigration.make({
    id: options.id,
    from: options.from,
    to: options.to,
    steps,
  })



  return freeze(migration)
}

const sqliteMigrationsCommand = (
  options: Readonly<{
    name: string
    tables: ReadonlyArray<Table>
    migrations: Option.Option<ReadonlyArray<SqliteMigration>>
    manifest: Option.Option<string>
  }>,
) => {
  const outFlag = Flag.file("out")
  const out = Flag.optional(outFlag)

  const snapshotCommand = Effect.fn("SqliteMigrations.snapshotCommand")(function* ({ out }) {
    const snapshot = snapshotFromTable(options.tables)
    const encodedSnapshot = encodeSnapshot(snapshot)
    return yield* writeJson(encodedSnapshot, out)
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
    const noBackfillEffect = Effect.succeed(noBackfill)

    const backfillIntent = yield* Option.match(input.backfill, {
      onNone: Function.constant(noBackfillEffect),
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

    const invalidIntentFlags = [invalidRename, invalidBackfill, invalidTransform]
    const hasInvalidIntent = Array.some(invalidIntentFlags, Boolean)
    if (hasInvalidIntent) {
      return yield* CliError.UserError.make({
        cause: migrationFailure("invalid migration intent"),
        userMessage: "--rename is table:from:to, --backfill is table:column:JSON-value, and --transform is table:column:SQL-expression",
      })
    }

    const valuesFrom = <A>(value: Option.Option<A>) =>
      Option.match(value, {
        onNone: Function.constant([]),
        onSome: (item) => [item],
      })

    const target = snapshotFromTable(options.tables)
    const renames = valuesFrom(renameIntent)
    const backfills = valuesFrom(backfillIntent)
    const transforms = valuesFrom(transformIntent)
    return planSqliteMigration({
      id: input.id,
      from: input.from,
      to: target,
      renames,
      backfills,
      transforms,
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

  const unresolvedMessage = (artifact: SqliteMigration) => {
    const blockedSteps = Array.filter(artifact.steps, Schema.is(SqliteBlockedChange))
    const reasons = Array.map(blockedSteps, Struct.get("reason"))
    const messageLines = Array.prepend(reasons, "Migration plan contains unresolved changes")
    return Array.join(messageLines, "\n")
  }

  const initialPrevious = emptySnapshot()
  const initialPreviousEffect = Effect.succeed(initialPrevious)

  const planCommand = Effect.fn("SqliteMigrations.planCommand")(function* (
    { from, id, rename, backfill, transform, out },
  ) {
    const previous = yield* Option.match(from, {
      onNone: Function.constant(initialPreviousEffect),
      onSome: readPrevious,
    })

    const artifact = yield* artifactFromIntents({
      id,
      from: previous,
      rename,
      backfill,
      transform,
    })

    const encodedArtifact = encodeMigration(artifact)
    yield* writeJson(encodedArtifact, out)
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
    const migrationManifest = readMigrationManifest(manifest)

    const loaded = yield* pipe(
      migrationManifest,
      Effect.mapError((cause) => CliError.UserError.make({
        cause,
        userMessage: "Could not load the registered SQLite migration manifest",
      })),
    )

    const configuredHistoryError = (cause: unknown) =>
      CliError.UserError.make({
        cause,
        userMessage: "Configured SQLite migration history is invalid",
      })

    const mismatchedHistoryCause = migrationFailure("configured history differs from manifest history")

    const mismatchedHistory = CliError.UserError.make({
      cause: mismatchedHistoryCause,
      userMessage: "Configured SQLite migration history must match the ordered manifest",
    })

    const completeConfiguredHistory = (configured: ReadonlyArray<SqliteMigration>) =>
      same(configured, loaded.migrations) ? Effect.succeed(loaded) : mismatchedHistory

    const loadedManifestEffect = Effect.succeed(loaded)

    const validateConfiguredHistory = flow(
      validateDecodedMigrations,
      Effect.mapError(configuredHistoryError),
      Effect.flatMap(completeConfiguredHistory),
    )

    return yield* Option.match(options.migrations, {
      onNone: Function.constant(loadedManifestEffect),
      onSome: validateConfiguredHistory,
    })
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

    const manifest = yield* Option.match(options.manifest, {
      onNone: () =>
        CliError.UserError.make({
          cause: migrationFailure("missing SQLite migration manifest"),
          userMessage: "generate requires a configured migration manifest",
        }),
      onSome: Effect.succeed,
    })

    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      return yield* CliError.UserError.make({
        cause: migrationFailure("invalid migration name"),
        userMessage: "migration name must contain only letters, numbers, underscores, or hyphens",
      })
    }

    const loaded = yield* registeredManifest(manifest)
    const last = Array.get(loaded.migrations, loaded.migrations.length - 1)

    const previous = Option.match(last, {
      onNone: emptySnapshot,
      onSome: migrationTo,
    })

    const lastId = Option.map(last, Struct.get("id"))

    const parseNumericPrefix = flow(
      (value: string) => /^(\d+)_/.exec(value),
      Option.fromNullishOr,
      Option.flatMap((match) => Array.get(match, 1)),
    )

    const numericPrefix = Option.flatMap(lastId, parseNumericPrefix)

    const nextNumber = Option.match(numericPrefix, {
      onNone: Function.constant("001"),
      onSome: (prefix) => {
        const value = Number(prefix)
        return Number.isSafeInteger(value)
          ? String(value + 1).padStart(prefix.length, "0")
          : ""
      },
    })

    const hasNoNextNumber = Equivalence.strictEqual<number>()(nextNumber.length, 0)
    if (hasNoNextNumber) {
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
    const alreadyRegistered = Array.contains(loaded.entries, entry)
    const artifactPathCollision = artifactExists || alreadyRegistered
    if (artifactPathCollision) {
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
    const nextHistory = Array.append(loaded.migrations, artifact)

    yield* pipe(
      validateDecodedMigrations(nextHistory),
      Effect.mapError((cause) => CliError.UserError.make({
        cause,
        userMessage: "Generated migration would make the registered history invalid",
      })),
    )


    const encodedArtifact = encodeMigration(artifact)
    const canonicalArtifact = canonical(encodedArtifact)
    const artifactText = `${JSON.stringify(canonicalArtifact, null, 2)}\n`
    const manifestEntries = Array.append(loaded.entries, entry)
    const manifestValue = canonical({ migrations: manifestEntries })
    const manifestText = `${JSON.stringify(manifestValue, null, 2)}\n`
    yield* fileSystem.writeFileString(artifactPath, artifactText, { flag: "wx" })
    const manifestParentDirectory = manifestDirectory(manifest)

    const temporaryManifest = yield* fileSystem.makeTempFile({
      directory: manifestParentDirectory,
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
  decodeHistory,
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

      const hasNoMigrations = Equivalence.strictEqual<number>()(migrations.length, 0)
      const hasApplicationTables = target.tables.length > 0
      const missingInitialHistory = hasNoMigrations && hasApplicationTables
      if (missingInitialHistory) {
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

      const hasChangedMigration = ([recorded, migration]: readonly [SqliteMigrationRow, SqliteMigration]) => {
        const idsMatch = Equivalence.strictEqual<string>()(recorded.id, migration.id)
        const suppliedArtifact = canonicalText(migration)

        const artifactsMatch = Equivalence.strictEqual<string>()(
          recorded.artifact,
          suppliedArtifact,
        )

        const differenceFlags = [!idsMatch, !artifactsMatch]
        return Array.some(differenceFlags, Boolean)
      }

      const comparedMigrations = Array.zip(ledger, migrations)
      const changedMigration = Array.findFirst(comparedMigrations, hasChangedMigration)
      if (Option.isSome(changedMigration)) {
        const [recorded] = changedMigration.value
        return yield* migrationFailure(`migration history changed at ${recorded.id}`)
      }


      const previousMigration = Array.get(migrations, ledger.length - 1)
      const hasEmptyLedger = Equivalence.strictEqual<number>()(ledger.length, 0)

      const expectedCurrent = hasEmptyLedger
        ? emptySnapshot()
        : Option.match(previousMigration, { onNone: emptySnapshot, onSome: migrationTo })

      yield* verifyDatabase(sql, expectedCurrent)

      const pendingMigrations = Array.drop(migrations, ledger.length)

      const applyPendingMigration = (migration: SqliteMigration, index: number) =>
        applyMigration(sql, migration, index + ledger.length)


      yield* Effect.forEach(pendingMigrations, applyPendingMigration, { discard: true })
      return yield* verifyDatabase(sql, target)
    }),
  })
