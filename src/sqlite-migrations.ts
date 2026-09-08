import { Array, Effect, Equivalence, FileSystem, flow, Function, HashMap, HashSet, Match, Option, Order, pipe, Predicate, Record, Schema, Stdio, Stream } from "effect"
import { CliError, Command, Flag } from "effect/unstable/cli"
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
const StateTable = "_effect_schema_state"

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
  const emptyKeys = HashSet.empty<string>()

  const addKey = (seen: HashSet.HashSet<string>, value: A) => {
    const valueKey = key(value)
    return HashSet.add(seen, valueKey)
  }

  const seenKeys = Array.scan(values, emptyKeys, addKey)
  const valuesLength = Array.length(values)
  const precedingKeys = Array.take(seenKeys, valuesLength)
  const valuesWithKeys = Array.zip(values, precedingKeys)

  const duplicateKey = ([value, seen]: readonly [A, HashSet.HashSet<string>]) => {
    const valueKey = key(value)
    return HashSet.has(seen, valueKey) ? [valueKey] : []
  }

  return Array.flatMap(valuesWithKeys, duplicateKey)
}

const identifiers = (snapshot: SqliteSchemaSnapshot): ReadonlyArray<string> => {
  const emptyTableNames = HashSet.empty<string>()

  const addTableName = (seen: HashSet.HashSet<string>, table: TableSnapshot) =>
    HashSet.add(seen, table.name)

  const seenTableNames = Array.scan(snapshot.tables, emptyTableNames, addTableName)
  const tableCount = Array.length(snapshot.tables)
  const precedingTableNames = Array.take(seenTableNames, tableCount)
  const tablesWithNames = Array.zip(snapshot.tables, precedingTableNames)

  const errorsForTable = ([table, tableNames]: readonly [TableSnapshot, HashSet.HashSet<string>]) => {
    const hasTableName = table.name.length > 0
    const hasIdentifier = table.identifier.length > 0
    const identityIsValid = hasTableName && hasIdentifier

    const identityErrors = identityIsValid
      ? []
      : ["table names and identifiers must not be empty"]

    const tableIsDuplicate = HashSet.has(tableNames, table.name)
    const tableErrors = tableIsDuplicate ? [`table ${table.name} occurs more than once`] : []
    const emptyFieldNames = HashSet.empty<string>()

    const addFieldName = (seen: HashSet.HashSet<string>, field: TableField) =>
      HashSet.add(seen, field.name)

    const seenFieldNames = Array.scan(table.fields, emptyFieldNames, addFieldName)
    const fieldCount = Array.length(table.fields)
    const precedingFieldNames = Array.take(seenFieldNames, fieldCount)
    const fieldsWithNames = Array.zip(table.fields, precedingFieldNames)

    const errorsForField = ([field, fieldNames]: readonly [TableField, HashSet.HashSet<string>]) => {
      const isEmptyName = Equivalence.strictEqual<number>()(field.name.length, 0)

      const emptyNameErrors = isEmptyName
        ? [`table ${table.name} contains an empty field name`]
        : []

      const isDuplicateName = HashSet.has(fieldNames, field.name)

      const duplicateNameErrors = isDuplicateName
        ? [`table ${table.name} contains field ${field.name} more than once`]
        : []

      return Array.appendAll(emptyNameErrors, duplicateNameErrors)
    }

    const fieldErrors = Array.flatMap(fieldsWithNames, errorsForField)
    const fieldEntries = Array.map(table.fields, fieldEntry)
    const entryName = ([name]: readonly [string, TableField]) => name
    const fieldNames = pipe(fieldEntries, Array.map(entryName), HashSet.fromIterable)
    const hasIdentifierField = HashSet.has(fieldNames, table.identifier)

    const identifierErrors = hasIdentifierField
      ? []
      : [`table ${table.name} has no identifier field ${table.identifier}`]

    const identityAndTableErrors = Array.appendAll(identityErrors, tableErrors)
    const fieldAndIdentifierErrors = Array.appendAll(fieldErrors, identifierErrors)
    return Array.appendAll(identityAndTableErrors, fieldAndIdentifierErrors)
  }

  return Array.flatMap(tablesWithNames, errorsForTable)
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
  const firstCause = Array.head(causes)
  const errorWithoutCause = MigrationError.make({ reason })
  const noCause = Function.constant(errorWithoutCause)
  const withCause = (cause: unknown) => MigrationError.make({ reason, cause })
  return Option.match(firstCause, { onNone: noCause, onSome: withCause })
}

const SqliteSnapshotJsonSchema = Schema.toCodecJson(SqliteSchemaSnapshot)
const SqliteSnapshotSourceSchema = Schema.fromJsonString(SqliteSnapshotJsonSchema)
const SqliteMigrationJsonSchema = Schema.toCodecJson(SqliteMigration)
const SqliteMigrationSourceSchema = Schema.fromJsonString(SqliteMigrationJsonSchema)

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

const sqlExpressionIsValid = (expression: string): boolean => {
  const trimmed = expression.trim()
  const hasContent = trimmed.length > 0
  const hasNullByte = expression.includes("\u0000")
  const hasSemicolon = expression.includes(";")
  const hasLineComment = expression.includes("--")
  const hasBlockComment = expression.includes("/*")
  const hasNoNullByte = !hasNullByte
  const contentHasNoNullByte = hasContent && hasNoNullByte
  const hasNoSemicolon = !hasSemicolon
  const contentHasNoSemicolon = contentHasNoNullByte && hasNoSemicolon
  const hasNoLineComment = !hasLineComment
  const contentHasNoLineComment = contentHasNoSemicolon && hasNoLineComment
  const hasNoBlockComment = !hasBlockComment
  return contentHasNoLineComment && hasNoBlockComment
}

const decodeSqliteRows = <S extends Schema.Top>(schema: S) => {
  const decodeRows = Schema.decodeUnknownEffect(schema)
  const decodedRows = Effect.flatMap(decodeRows)
  return decodedRows
}

const decodeUnknownSqliteQuery = decodeSqliteRows(Schema.Unknown)

const applyStatement = (sql: SqlClient.SqlClient, statement: string) => {
  const literal = sql.literal(statement)
  return pipe(
    sql`${literal}`,
    decodeUnknownSqliteQuery,
    Effect.asVoid,
    Effect.mapError((cause) => migrationFailure("SQLite schema operation failed", cause)),
  )
}

const ensureMetadata = (sql: SqlClient.SqlClient) => {
  const ledgerStatement = `CREATE TABLE IF NOT EXISTS ${quote(LedgerTable)} (position INTEGER PRIMARY KEY NOT NULL, id TEXT UNIQUE NOT NULL, artifact TEXT NOT NULL)`
  const stateStatement = `CREATE TABLE IF NOT EXISTS ${quote(StateTable)} (key TEXT PRIMARY KEY NOT NULL, snapshot TEXT NOT NULL)`
  const createLedger = applyStatement(sql, ledgerStatement)
  const createState = applyStatement(sql, stateStatement)
  return Effect.all([createLedger, createState], { discard: true })
}

const SqliteNullableStringSchema = Schema.NullOr(Schema.String)
const SqliteStateRowSchema = Schema.Struct({ snapshot: Schema.String })
interface SqliteStateRow extends Schema.Schema.Type<typeof SqliteStateRowSchema> {}
const SqliteTableObjectRowSchema = Schema.Struct({ name: Schema.String })
interface SqliteTableObjectRow extends Schema.Schema.Type<typeof SqliteTableObjectRowSchema> {}

const SqliteMigrationRowSchema = Schema.Struct({
  id: Schema.String,
  artifact: Schema.String,
})

interface SqliteMigrationRow extends Schema.Schema.Type<typeof SqliteMigrationRowSchema> {}

const SqliteTableSqlRowSchema = Schema.Struct({ sql: SqliteNullableStringSchema })
interface SqliteTableSqlRow extends Schema.Schema.Type<typeof SqliteTableSqlRowSchema> {}
const SqliteStateRowsSchema = Schema.Array(SqliteStateRowSchema)
const SqliteTableObjectRowsSchema = Schema.Array(SqliteTableObjectRowSchema)
const SqliteMigrationRowsSchema = Schema.Array(SqliteMigrationRowSchema)
const SqliteTableSqlRowsSchema = Schema.Array(SqliteTableSqlRowSchema)
const decodeStateRows = decodeSqliteRows(SqliteStateRowsSchema)
const decodeTableObjectRows = decodeSqliteRows(SqliteTableObjectRowsSchema)
const decodeMigrationRows = decodeSqliteRows(SqliteMigrationRowsSchema)
const decodeTableSqlRows = decodeSqliteRows(SqliteTableSqlRowsSchema)

const currentState = (sql: SqlClient.SqlClient) => {
  const state = sql(StateTable)

  const noCurrentState = () =>
    pipe(Option.none<SqliteSchemaSnapshot>(), Effect.succeed)

  const decodeStateRow = (row: SqliteStateRow) =>
    pipe(decodeSnapshot(row.snapshot), Effect.map(Option.some))

  const decodeStateRowsOption = (rows: ReadonlyArray<SqliteStateRow>) => {
    const current = Array.head(rows)
    return Option.match(current, {
      onNone: noCurrentState,
      onSome: decodeStateRow,
    })
  }

  return pipe(
    sql`SELECT snapshot FROM ${state} WHERE key = 'current'`,
    decodeStateRows,
    Effect.flatMap(decodeStateRowsOption),
    Effect.mapError((cause) => migrationFailure("could not read SQLite schema state", cause)),
  )
}

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

const recordState = (sql: SqlClient.SqlClient, snapshot: SqliteSchemaSnapshot) => {
  const artifact = canonicalText(snapshot)
  return pipe(
    sql`INSERT INTO ${sql(StateTable)} (key, snapshot) VALUES ('current', ${artifact})
      ON CONFLICT(key) DO UPDATE SET snapshot = excluded.snapshot`,
    decodeUnknownSqliteQuery,
    Effect.asVoid,
    Effect.mapError((cause) => migrationFailure("could not record SQLite schema state", cause)),
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
    decodeUnknownSqliteQuery,
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
        AND name NOT IN (${LedgerTable}, ${StateTable})
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
      decodeUnknownSqliteQuery,
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
    yield* recordState(sql, migration.to)
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

const isCreateOnlyInitial = (
  migration: SqliteMigration,
  snapshot: SqliteSchemaSnapshot,
): boolean => {
  const initialSnapshot = emptySnapshot()
  const matchingSource = same(migration.from, initialSnapshot)
  const matchingTarget = same(migration.to, snapshot)
  const matchingEndpoints = matchingSource && matchingTarget
  const matchingStepCount = Equivalence.strictEqual<number>()(migration.steps.length, snapshot.tables.length)

  const tableMatchesStep = (step: SqliteMigrationStep, index: number) => {
    const table = Array.get(snapshot.tables, index)

    const matchesStep = (candidate: TableSnapshot) =>
      pipe(
        Match.value(step),
        Match.tagsExhaustive({
          SqliteCreateTable: (create) => same(create.table, candidate),
          SqliteAddColumn: Function.constFalse,
          SqliteRenameColumn: Function.constFalse,
          SqliteRebuildTable: Function.constFalse,
          SqliteBlockedChange: Function.constFalse,
        }),
      )

    return Option.match(table, { onNone: Function.constFalse, onSome: matchesStep })
  }

  const createsMatchingTables = Array.every(migration.steps, tableMatchesStep)
  const matchingStructure = matchingEndpoints && matchingStepCount
  return matchingStructure && createsMatchingTables
}

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
const StringArraySchema = Schema.Array(Schema.String)

class FieldPlan extends Schema.Class<FieldPlan>("SqliteFieldPlan")({
  target: TableField,
  rename: SqliteRenameOptionSchema,
  transform: SqliteTransformOptionSchema,
  backfill: SqliteBackfillOptionSchema,
  sourceName: Schema.String,
  sourceField: TableFieldOptionSchema,
  expression: StringOptionSchema,
  errors: StringArraySchema,
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
      const source = HashMap.get(fromTables, target.name)
      return Option.match(source, {
        onNone: () => {
          const createTable = SqliteCreateTable.make({ table: target })
          const step = freeze(createTable)
          const usedRenames = HashSet.empty<SqliteRename>()
          const usedBackfills = HashSet.empty<SqliteBackfill>()
          const usedTransforms = HashSet.empty<SqliteTransform>()
          return [[step], [], usedRenames, usedBackfills, usedTransforms] as const
        },
        onSome: (source) => {
          const sourceFields = fieldMap(source)

          const fieldPlanForTarget = (targetField: TableField) => {
            const key = `${target.name}\u0000${targetField.name}`
            const rename = HashMap.get(renamesByTarget, key)
            const transform = HashMap.get(transformsByColumn, key)
            const backfill = HashMap.get(backfillsByColumn, key)
            const targetName = Function.constant(targetField.name)
            const fromRenameIntent = (intent: SqliteRename) => `${intent.from}`
            const sourceName = Option.match(rename, { onNone: targetName, onSome: fromRenameIntent })
            const sourceField = HashMap.get(sourceFields, sourceName)
            const storageChangeForField = (field: TableField) => !normalizedFieldEquals(field, targetField)

            const hasValidTransform = Option.match(transform, {
              onNone: Function.constFalse,
              onSome: (intent) => sqlExpressionIsValid(intent.expression),
            })


            const storageChanged = Option.match(sourceField, {
              onNone: Function.constFalse,
              onSome: storageChangeForField,
            })

            const sourceFieldExists = Option.isSome(sourceField)
            const requiresTransform = sourceFieldExists && storageChanged
            const hasNoValidTransform = !hasValidTransform
            const missingTransform = requiresTransform && hasNoValidTransform
            const sourceFieldIsMissing = Option.isNone(sourceField)
            const hasNoTransform = !hasValidTransform
            const hasNoBackfill = Option.isNone(backfill)
            const requiresValue = !targetField.nullable
            const noFallback = hasNoTransform && hasNoBackfill
            const missingValueCandidate = sourceFieldIsMissing && noFallback
            const missingValue = missingValueCandidate && requiresValue
            const transformExpression = (intent: SqliteTransform) => `${intent.expression}`
            const expression = hasValidTransform ? Option.map(transform, transformExpression) : Option.none<string>()

            const missingTransformErrors = missingTransform
              ? [`field ${target.name}.${targetField.name} changes storage metadata without a transform`]
              : []

            const missingValueErrors = missingValue
              ? [`field ${target.name}.${targetField.name} requires an explicit backfill or transform`]
              : []

            const errors = Array.appendAll(missingTransformErrors, missingValueErrors)

            return FieldPlan.make({
              target: targetField,
              rename,
              transform,
              backfill,
              sourceName,
              sourceField,
              expression,
              errors,
            })

          }

          const fieldPlans = Array.map(target.fields, fieldPlanForTarget)

          const mappedEntries = (fieldPlan: FieldPlan) => {
            const entryFromSource = Function.constant([[fieldPlan.target.name, fieldPlan.sourceName] as const])

            return Option.match(fieldPlan.sourceField, {
              onNone: Function.constant([]),
              onSome: entryFromSource,
            })

          }

          const mappedEntriesArray = Array.flatMap(fieldPlans, mappedEntries)
          const mapped = HashMap.fromIterable(mappedEntriesArray)

          const transformedEntries = (fieldPlan: FieldPlan) => {
            const entryFromString = (value: string) => [[fieldPlan.target.name, value] as const]

            return Option.match(fieldPlan.expression, {
              onNone: Function.constant([]),
              onSome: entryFromString,
            })

          }

          const transformedEntriesArray = Array.flatMap(fieldPlans, transformedEntries)
          const transformed = HashMap.fromIterable(transformedEntriesArray)
          const mappedSources = HashMap.values(mapped)
          const retainedSources = HashSet.fromIterable(mappedSources)

          const retainedErrorForSource = (sourceField: TableField) =>
            HashSet.has(retainedSources, sourceField.name)
              ? []
              : [`field ${target.name}.${sourceField.name} would be dropped or renamed without intent`]

          const retainedErrors = Array.flatMap(source.fields, retainedErrorForSource)


          const sourceMissingWithBackfill = (fieldPlan: FieldPlan) =>
            Option.match(fieldPlan.sourceField, {
              onNone: () => Option.isSome(fieldPlan.backfill),
              onSome: Function.constFalse,
            })


          const backfillRequiresRebuild = Array.some(fieldPlans, sourceMissingWithBackfill)
          const hasTransformation = HashMap.size(transformed) > 0
          const rebuild = hasTransformation || backfillRequiresRebuild

          const renamesFromFieldplan = (fieldPlan: FieldPlan) =>
            Option.match(fieldPlan.rename, {
              onNone: Function.constant([]),
              onSome: (intent) => [intent],
            })

          const renameIntents = Array.flatMap(fieldPlans, renamesFromFieldplan)
          const usedRenames = HashSet.fromIterable(renameIntents)

          const transformsFromFieldplan = (fieldPlan: FieldPlan) => {
            const hasExpression = Option.isSome(fieldPlan.expression)
            if (!hasExpression) {
              return []
            }
            return Option.match(fieldPlan.transform, {
              onNone: Function.constant([]),
              onSome: (intent) => [intent],
            })
          }

          const transformIntents = Array.flatMap(fieldPlans, transformsFromFieldplan)
          const usedTransforms = HashSet.fromIterable(transformIntents)

          const backfillsFromFieldplan = (fieldPlan: FieldPlan) => {
            const hasExpression = Option.isSome(fieldPlan.expression)
            const sourceIsMissing = Option.isNone(fieldPlan.sourceField)
            const hasNoExpression = !hasExpression
            const needsBackfill = hasNoExpression && sourceIsMissing
            if (!needsBackfill) {
              return []
            }
            return Option.match(fieldPlan.backfill, {

              onNone: Function.constant([]),
              onSome: (intent) => [intent],
            })
          }


          const backfillIntents = Array.flatMap(fieldPlans, backfillsFromFieldplan)
          const usedBackfills = rebuild ? HashSet.fromIterable(backfillIntents) : HashSet.empty<SqliteBackfill>()


          const copiesFromFieldplan = (
            fieldPlan: FieldPlan,
          ): ReadonlyArray<SqliteColumnSource | SqliteColumnValue | SqliteColumnExpression> => {
            if (Option.isSome(fieldPlan.expression)) {

              const expression = SqliteColumnExpression.make({

                column: fieldPlan.target.name,
                expression: fieldPlan.expression.value,

              })


              return [freeze(expression)]
            }
            if (Option.isSome(fieldPlan.sourceField)) {

              const source = SqliteColumnSource.make({

                column: fieldPlan.target.name,
                source: fieldPlan.sourceField.value.name,
              })

              return [freeze(source)]
            }


            const copyBackfill = (intent: SqliteBackfill) => {

              const value = SqliteColumnValue.make({
                column: fieldPlan.target.name,
                value: intent.value,
              })

              return [freeze(value)]

            }

            return Option.match(fieldPlan.backfill, {
              onNone: Function.constant([]),
              onSome: copyBackfill,
            })
          }



          const sqliteMigrationStepsFromFieldplan = (fieldPlan: FieldPlan): ReadonlyArray<SqliteMigrationStep> => {
            if (Option.isNone(fieldPlan.sourceField)) {
              const addition = SqliteAddColumn.make({ table: target.name, column: fieldPlan.target })
              const addedColumn = [freeze(addition)]
              return fieldPlan.target.nullable ? addedColumn : []

            }
            const sameFieldName = Equivalence.strictEqual<string>()(fieldPlan.sourceField.value.name, fieldPlan.target.name)
            if (sameFieldName) {

              return []
            }

            const rename = SqliteRenameColumn.make({
              table: target.name,
              from: fieldPlan.sourceField.value.name,

              to: fieldPlan.target.name,
            })



            return [freeze(rename)]
          }



          const createRebuildStep = () => {
            const copies = Array.flatMap(fieldPlans, copiesFromFieldplan)
            const rebuildTable = SqliteRebuildTable.make({ table: target, copies })
            return [freeze(rebuildTable)]

          }

          const steps = rebuild ? createRebuildStep() : Array.flatMap(fieldPlans, sqliteMigrationStepsFromFieldplan)

          const identifierErrors = Equivalence.strictEqual<string>()(source.identifier, target.identifier)
            ? []
            : [`table ${target.name} changes its identifier`]

          const fieldPlanErrorEntries = Array.map(fieldPlans, (fieldPlan) => [fieldPlan.errors] as const)
          const fieldPlanErrors = Array.flatMap(fieldPlanErrorEntries, ([errors]) => errors)
          const planErrors = Array.appendAll(identifierErrors, fieldPlanErrors)
          const allErrors = Array.appendAll(planErrors, retainedErrors)
          return [steps, allErrors, usedRenames, usedBackfills, usedTransforms] as const
        },
      })
    }

    const tablePlans = Array.map(options.to.tables, planTable)
    const emptyRenames = HashSet.empty<SqliteRename>()

    const unionRenames = (
      used: HashSet.HashSet<SqliteRename>,
      [, , planRenames]: (typeof tablePlans)[number],
    ) => HashSet.union(used, planRenames)

    const usedRenames = Array.reduce(tablePlans, emptyRenames, unionRenames)
    const emptyBackfills = HashSet.empty<SqliteBackfill>()

    const unionBackfills = (
      used: HashSet.HashSet<SqliteBackfill>,
      [, , , planBackfills]: (typeof tablePlans)[number],
    ) => HashSet.union(used, planBackfills)

    const usedBackfills = Array.reduce(tablePlans, emptyBackfills, unionBackfills)
    const emptyTransforms = HashSet.empty<SqliteTransform>()

    const unionTransforms = (
      used: HashSet.HashSet<SqliteTransform>,
      [, , , , planTransforms]: (typeof tablePlans)[number],
    ) => HashSet.union(used, planTransforms)

    const usedTransforms = Array.reduce(tablePlans, emptyTransforms, unionTransforms)
    const fromIdentifiers = identifiers(options.from)
    const toIdentifiers = identifiers(options.to)
    const identifiersErrors = Array.appendAll(fromIdentifiers, toIdentifiers)
    const duplicateRenameKey = (rename: SqliteRename) => `${rename.table}\u0000${rename.to}`
    const duplicateBackfillKey = (backfill: SqliteBackfill) => `${backfill.table}\u0000${backfill.column}`

    const duplicateTransformKey = (transform: SqliteTransform) =>
      `${transform.table}\u0000${transform.column}`

    const renameIntentError = (key: string) => `duplicate rename intent for ${key.replace("\u0000", ".")}`
    const backfillIntentError = (key: string) => `duplicate backfill intent for ${key.replace("\u0000", ".")}`
    const transformIntentError = (key: string) => `duplicate transform intent for ${key.replace("\u0000", ".")}`
    const duplicateRenameKeys = duplicateIntentKeys(renames, duplicateRenameKey)
    const duplicateBackfillKeys = duplicateIntentKeys(backfills, duplicateBackfillKey)
    const duplicateTransformKeys = duplicateIntentKeys(transforms, duplicateTransformKey)
    const renameIntentErrors = Array.map(duplicateRenameKeys, renameIntentError)
    const backfillIntentErrors = Array.map(duplicateBackfillKeys, backfillIntentError)
    const transformIntentErrors = Array.map(duplicateTransformKeys, transformIntentError)
    const duplicateIntentErrors = Array.appendAll(renameIntentErrors, backfillIntentErrors)
    const allIntentErrors = Array.appendAll(duplicateIntentErrors, transformIntentErrors)
    const intentErrors = Array.appendAll(identifiersErrors, allIntentErrors)


    const migrationIdErrors = Equivalence.strictEqual<number>()(options.id.length, 0)
      ? ["migration id must not be empty"]
      : []


    const transformError = (transform: SqliteTransform) =>
      sqlExpressionIsValid(transform.expression)
        ? []
        : [`transform ${transform.table}.${transform.column} must be one SQL expression without comments or semicolons`]

    const transformErrors = Array.flatMap(transforms, transformError)

    const droppedTableError = (table: TableSnapshot) =>
      HashMap.has(toTables, table.name) ? [] : [`table ${table.name} would be dropped`]

    const tableErrors = Array.flatMap(options.from.tables, droppedTableError)

    const unusedRenameError = (rename: SqliteRename) =>
      HashSet.has(usedRenames, rename) ? [] : [`unused rename intent for ${rename.table}.${rename.from}`]

    const unusedRenameErrors = Array.flatMap(renames, unusedRenameError)

    const unusedBackfillError = (backfill: SqliteBackfill) =>
      HashSet.has(usedBackfills, backfill) ? [] : [`unused backfill intent for ${backfill.table}.${backfill.column}`]

    const unusedBackfillErrors = Array.flatMap(backfills, unusedBackfillError)

    const unusedTransformError = (transform: SqliteTransform) =>
      HashSet.has(usedTransforms, transform) ? [] : [`unused transform intent for ${transform.table}.${transform.column}`]

    const unusedTransformErrors = Array.flatMap(transforms, unusedTransformError)
    const unusedRenameAndBackfillErrors = Array.appendAll(unusedRenameErrors, unusedBackfillErrors)
    const unusedErrors = Array.appendAll(unusedRenameAndBackfillErrors, unusedTransformErrors)
    const migrationAndTransformErrors = Array.appendAll(migrationIdErrors, transformErrors)
    const migrationTransformAndTableErrors = Array.appendAll(migrationAndTransformErrors, tableErrors)
    const validationErrors = Array.appendAll(intentErrors, migrationTransformAndTableErrors)
    const validationAndUnusedErrors = Array.appendAll(validationErrors, unusedErrors)
    const tablePlanErrors = Array.flatMap(tablePlans, ([, errors]) => errors)
    const plannedSteps = Array.flatMap(tablePlans, ([steps]) => steps)
    const errors = Array.appendAll(validationAndUnusedErrors, tablePlanErrors)
    const blockedSteps = Array.map(errors, blocked)
    const steps = Array.appendAll(plannedSteps, blockedSteps)

    const migration = SqliteMigration.make({
      id: options.id,
      from: options.from,
      to: options.to,
      steps,
    })

  return freeze(migration)
}

const sqliteMigrationsCommand = (options: Readonly<{ name: string; tables: ReadonlyArray<Table> }>) => {
    const outFlag = Flag.file("out")
    const out = Flag.optional(outFlag)

    const snapshotCommand = Effect.fn("SqliteMigrations.snapshotCommand")(function* ({ out }) {
      const snapshot = snapshotFromTable(options.tables)
      return yield* writeJson(snapshot, out)
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

    const transformDescription = Flag.withDescription(
      "table:column:SQL-expression; the expression reads physical --from columns before renames",
    )

    const describedTransform = transformDescription(transformFlag)
    const transform = Flag.optional(describedTransform)
    const planOptions = { from, id, rename, backfill, transform, out }

    const planCommand = Effect.fn("SqliteMigrations.planCommand")(function* (
      { from, id, rename, backfill, transform, out },
    ) {

      const fileSystem = yield* FileSystem.FileSystem
      const initialSnapshot = emptySnapshot()
      const initialSnapshotEffect = Effect.succeed(initialSnapshot)
      const noPrevious = Function.constant(initialSnapshotEffect)


      const readPrevious = (path: string) => {
        const source = fileSystem.readFileString(path)

        const readError = (cause: unknown) => CliError.UserError.make({
          cause,
          userMessage: "Could not read --from snapshot or migration artifact",
        })

        return pipe(source, Effect.flatMap(decodeSource), Effect.mapError(readError))

      }

      const previous = yield* Option.match(from, { onNone: noPrevious, onSome: readPrevious })
      const renameIntent = Option.flatMap(rename, parseSqliteRename)
      const noBackfill = Option.none<SqliteBackfill>()
      const noBackfillEffect = Effect.succeed(noBackfill)
      const noBackfillIntent = Function.constant(noBackfillEffect)

      const backfillIntent = yield* Option.match(backfill, {
        onNone: noBackfillIntent,
        onSome: parseSqliteBackfill,
      })

      const transformIntent = Option.flatMap(transform, parseSqliteTransform)
      const invalidRenameIntent = Option.isNone(renameIntent)
      const invalidBackfillIntent = Option.isNone(backfillIntent)
      const invalidTransformIntent = Option.isNone(transformIntent)

      const invalidRename = Option.match(rename, {
        onNone: Function.constFalse,
        onSome: Function.constant(invalidRenameIntent),
      })


      const invalidBackfill = Option.match(backfill, {
        onNone: Function.constFalse,
        onSome: Function.constant(invalidBackfillIntent),
      })


      const invalidTransform = Option.match(transform, {
        onNone: Function.constFalse,
        onSome: Function.constant(invalidTransformIntent),
      })

      const hasInvalidRenameOrBackfill = invalidRename || invalidBackfill
      const hasInvalidIntent = hasInvalidRenameOrBackfill || invalidTransform
      if (hasInvalidIntent) {
        const cause = migrationFailure("invalid migration intent")
        return yield* CliError.UserError.make({
          cause,
          userMessage: "--rename is table:from:to, --backfill is table:column:JSON-value, and --transform is table:column:SQL-expression",
        })
      }

      const snapshot = snapshotFromTable(options.tables)

      const valuesFromA = <A>(value: Option.Option<A>) =>
        Option.match(value, {
          onNone: Function.constant([]),
          onSome: (item) => [item],
        })

      const renames = valuesFromA(renameIntent)
      const backfills = valuesFromA(backfillIntent)
      const transforms = valuesFromA(transformIntent)
      const artifact = planSqliteMigration({ id, from: previous, to: snapshot, renames, backfills, transforms })
      yield* writeJson(artifact, out)
      const hasBlockedChange = Array.some(artifact.steps, Schema.is(SqliteBlockedChange))
      if (hasBlockedChange) {
        return yield* CliError.UserError.make({
          cause: artifact,
          userMessage: "Migration plan contains unresolved changes",
        })
      }
    })

    const plan = Command.make("plan", planOptions, planCommand)
    const command = Command.make(options.name)
    return Command.withSubcommands(command, [snapshot, plan])
}

export const SqliteMigrations = {
  snapshot: snapshotFromTable,
  plan: planSqliteMigration,
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

      const snapshots = Option.match(lastMigration, {
        onNone: emptySnapshot,
        onSome: migrationTo,
      })

      const hasMigrations = migrations.length > 0
      const historyMatchesTarget = hasMigrations ? same(snapshots, target) : true
      if (!historyMatchesTarget) {
        return yield* migrationFailure("the frozen migration history does not end at the application schema")
      }

      yield* ensureMetadata(sql)

      const stateEffect = currentState(sql)
      const ledgerEffect = recordedMigrations(sql)
      const tablesEffect = userTables(sql)
      const [state, ledger, existing] = yield* Effect.all([stateEffect, ledgerEffect, tablesEffect])
      const hasNoLedger = Equivalence.strictEqual<number>()(ledger.length, 0)
      const hasNoState = Option.isNone(state)
      const hasExistingTables = existing.length > 0
      const lacksMetadata = hasNoLedger && hasNoState
      const hasUntrackedTables = lacksMetadata && hasExistingTables
      if (hasUntrackedTables) {
        return yield* migrationFailure("SQLite already contains untracked tables; refusing to adopt an unknown schema")
      }


      const recordInitialMigration = Effect.fn("SqliteMigrations.recordInitialMigration")(function* (
        initial: SqliteMigration,
      ) {


        const recordInitialMigrationTransaction = Effect.fn(
          "SqliteMigrations.recordInitialMigrationTransaction",
        )(function*() {
          yield* recordMigration(sql, initial, 0)
          yield* recordState(sql, initial.to)
        })

        const transactionEffect = recordInitialMigrationTransaction()
        const transaction = sql.withTransaction(transactionEffect)
        return yield* pipe(
          transaction,
          Effect.mapError((cause) => migrationFailure("could not record initial SQLite migration history", cause)),
        )
      })


      const bootstrapInitialMigration = Effect.fn("SqliteMigrations.bootstrapInitialMigration")(function* (
        currentSnapshot: SqliteSchemaSnapshot,
      ) {
        const firstMigration = Array.head(migrations)
        const noInitialMigration = () => migrationFailure("SQLite bootstrap requires an initial migration")

        const initial = yield* Option.match(firstMigration, {
          onNone: noInitialMigration,
          onSome: Effect.succeed,
        })

        const hasMatchingInitialMigration = isCreateOnlyInitial(initial, currentSnapshot)
        if (!hasMatchingInitialMigration) {
          return yield* migrationFailure("SQLite was bootstrapped without matching initial CreateTable history")
        }

        yield* verifyDatabase(sql, currentSnapshot)
        yield* recordInitialMigration(initial)
        return 1
      })

      const shouldBootstrap = hasNoLedger && hasMigrations

      const applied = yield* Option.match(state, {
        onNone: () => Effect.succeed(ledger.length),
        onSome: (currentSnapshot) =>
          shouldBootstrap
            ? bootstrapInitialMigration(currentSnapshot)
            : Effect.succeed(ledger.length),
      })

      if (ledger.length > migrations.length) {
        return yield* migrationFailure("SQLite contains migration history not supplied by the application")
      }

      const recordedAndSupplied = Array.zip(ledger, migrations)

      const migrationDifferFromRecorded = ([recorded, supplied]: (typeof recordedAndSupplied)[number]): boolean => {
        const matchingId = Equivalence.strictEqual<string>()(recorded.id, supplied.id)
        const suppliedArtifact = canonicalText(supplied)
        const matchingArtifact = Equivalence.strictEqual<string>()(recorded.artifact, suppliedArtifact)
        const migrationMatches = matchingId && matchingArtifact
        return !migrationMatches
      }

      const changedMigration = Array.findFirst(recordedAndSupplied, migrationDifferFromRecorded)

      if (Option.isSome(changedMigration)) {
        const [recorded] = changedMigration.value
        return yield* migrationFailure(`migration history changed at ${recorded.id}`)
      }

      const verifyAppliedHistory = Effect.fn("SqliteMigrations.verifyAppliedHistory")(function*() {
        const previousMigration = Array.get(migrations, applied - 1)

        const before = Equivalence.strictEqual<number>()(applied, 0)
          ? emptySnapshot()
          : Option.match(previousMigration, {
            onNone: emptySnapshot,
            onSome: migrationTo,
          })

        const stateMatchesBefore = (current: SqliteSchemaSnapshot) => same(current, before)

        const decodedStateMatchesBefore = yield* Option.match(state, {
          onNone: () => Effect.succeed(true),
          onSome: flow(stateMatchesBefore, Effect.succeed),
        })

        if (!decodedStateMatchesBefore) {
          return yield* migrationFailure("SQLite schema state does not match its applied migration history")
        }

        const hasAppliedHistory = applied > 0
        const hasMissingState = hasNoState && hasAppliedHistory
        if (hasMissingState) {
          return yield* migrationFailure("SQLite migration history has no tracked schema state")
        }

        return yield* verifyDatabase(sql, before)
      })

      if (hasMigrations) {
        yield* verifyAppliedHistory()
      }

      if (!hasMigrations) {
        const initializeSchema = Effect.fn("SqliteMigrations.initializeSchema")(function*() {
          const applyRenderedStatement = (statement: string) => applyStatement(sql, statement)
          const createTable = flow(renderCreateTable, applyRenderedStatement)

          const initializeSchemaTransaction = Effect.fn(
            "SqliteMigrations.initializeSchemaTransaction",
          )(function*() {

            yield* Effect.forEach(target.tables, createTable, { discard: true })
            yield* verifyDatabase(sql, target)
            yield* recordState(sql, target)
          })

          const transactionEffect = initializeSchemaTransaction()
          const transaction = sql.withTransaction(transactionEffect)
          return yield* pipe(
            transaction,
            Effect.mapError((cause) => migrationFailure("could not initialize SQLite schema", cause)),
          )
        })

        const checkTargetState = Effect.fn("SqliteMigrations.checkTargetState")(function* (
          current: SqliteSchemaSnapshot,
        ) {
          const matchesTarget = same(current, target)
          if (!matchesTarget) {
            return yield* migrationFailure("application schema changed without a frozen migration artifact")
          }
        })

        yield* Option.match(state, {
          onNone: initializeSchema,
          onSome: checkTargetState,
        })
        return yield* verifyDatabase(sql, target)
      }

      const applyPendingMigration = (migration: SqliteMigration, index: number) =>
        applyMigration(sql, migration, index + applied)

      const pendingMigrations = Array.drop(migrations, applied)
      yield* Effect.forEach(pendingMigrations, applyPendingMigration, { discard: true })

      const after = yield* currentState(sql)
      const stateMatchesTarget = (current: SqliteSchemaSnapshot) => same(current, target)

      const finalStateMatchesTarget = yield* Option.match(after, {
        onNone: () => Effect.succeed(false),
        onSome: flow(stateMatchesTarget, Effect.succeed),
      })

      if (!finalStateMatchesTarget) {
        return yield* migrationFailure("SQLite schema state does not match the frozen migration history")
      }

      return yield* verifyDatabase(sql, target)
    }),
  })
