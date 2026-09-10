import { Array, Effect, Equivalence, FileSystem, flow, Function, HashMap, HashSet, Match, Option, Order, pipe, Predicate, Record, Schema, Struct } from "effect"
import { SqlClient, Statement } from "effect/unstable/sql"
import { MigrationError, SchemaStore } from "./migrations.ts"

import {
  Table,
  TableField,
  TableSnapshot,
} from "./table.ts"

import { quoteIdentifier, renderColumn, renderCreateIndexes, renderCreateTable, renderIndex } from "./sqlite-ddl.ts"
const SchemaVersion = 1
const LedgerTable = "_effect_schema_migrations"
const MigrationValueSchema = Schema.Union([Schema.String, Schema.Number, Schema.Null])
const SchemaVersionSchema = Schema.Literal(SchemaVersion)
const TableSnapshotsSchema = Schema.Array(TableSnapshot)

class SqliteSchemaSnapshot extends Schema.Class<SqliteSchemaSnapshot>(
  "SqliteSchemaSnapshot",
)({
  version: SchemaVersionSchema,
  tables: TableSnapshotsSchema,
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
const SqliteIndexFieldsSchema = Schema.Array(Schema.String)

class SqliteRebuildTable extends Schema.TaggedClass<SqliteRebuildTable>()(
  "SqliteRebuildTable",
  {
    table: TableSnapshot,
    copies: SqliteColumnCopiesSchema,
  },
) {}

class SqliteCreateIndex extends Schema.TaggedClass<SqliteCreateIndex>()(
  "SqliteCreateIndex",
  {
    table: Schema.String,
    name: Schema.String,
    fields: SqliteIndexFieldsSchema,
  },
) {}

class SqliteDropIndex extends Schema.TaggedClass<SqliteDropIndex>()(
  "SqliteDropIndex",
  { name: Schema.String },
) {}

const SqliteMigrationStepSchema = Schema.Union([
  SqliteCreateTable,
  SqliteAddColumn,
  SqliteRenameColumn,
  SqliteRebuildTable,
  SqliteCreateIndex,
  SqliteDropIndex,
])

type SqliteMigrationStep = Schema.Schema.Type<typeof SqliteMigrationStepSchema>
const SqliteMigrationStepsSchema = Schema.Array(SqliteMigrationStepSchema)

export class SqliteMigration extends Schema.Class<SqliteMigration>("SqliteMigration")({
  id: Schema.String,
  from: SqliteSchemaSnapshot,
  to: SqliteSchemaSnapshot,
  steps: SqliteMigrationStepsSchema,
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
const snapshotEquals = Schema.toEquivalence(SqliteSchemaSnapshot)

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

const migrationFieldEntry = (field: TableField) => [field.name, field] as const
const migrationTableEntry = (table: TableSnapshot) => [table.name, table] as const

const fieldMap = (table: TableSnapshot) =>
  pipe(table.fields, Array.map(migrationFieldEntry), HashMap.fromIterable)



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
    const isIdentifier = (field: TableField) => Equivalence.strictEqual<string>()(field.name, table.identifier)
    const identifierField = Array.findFirst(table.fields, isIdentifier)
    const hasIdentifierField = Option.isSome(identifierField)
    const nullableIdentifier = Option.exists(identifierField, Struct.get("nullable"))

    const missingIdentifierErrors = hasIdentifierField
      ? errorsWithFields
      : Array.append(errorsWithFields, `table ${table.name} has no identifier field ${table.identifier}`)

    const nextErrors = nullableIdentifier
      ? Array.append(missingIdentifierErrors, `table ${table.name} identifier field ${table.identifier} must not be nullable`)
      : missingIdentifierErrors

    return [HashSet.add(tableNames, table.name), nextErrors] as const
  }

  const initial = [HashSet.empty<string>(), [] as ReadonlyArray<string>] as const
  const [, errors] = Array.reduce(snapshot.tables, initial, validateTable)
  return errors
}

const snapshotFromTable = flow(Array.map(Table.snapshot), schemaSnapshot)

const normalizedSql = (sql: string) => {
  const tokens = sql.trim().replace(/;$/, "").match(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[^\s]/g,
  ) ?? []

  return Array.join(tokens, "\u0000")
}

const declaredIndexes = (table: TableSnapshot) => table.relations?.indexes ?? []
type DeclaredIndex = ReturnType<typeof declaredIndexes>[number]

const migrationFailure = (reason: string, cause: unknown = undefined): MigrationError => {
  const firstCause = Option.fromUndefinedOr(cause)
  const failureWithoutCause = MigrationError.make({ reason })

  return Option.match(firstCause, {
    onNone: Function.constant(failureWithoutCause),
    onSome: (value) => MigrationError.make({ reason, cause: value }),
  })
}

const relationFailure = (cause: unknown) => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return migrationFailure(reason, cause)
}

const validateSnapshot = (snapshot: SqliteSchemaSnapshot): Effect.Effect<SqliteSchemaSnapshot, MigrationError> => {
  const identityErrors = identifiers(snapshot)
  const reason = Array.join(identityErrors, "; ")
  const valid = Equivalence.strictEqual<number>()(identityErrors.length, 0)

  if (!valid) {
    const failure = migrationFailure(reason)
    return Effect.fail(failure)
  }

  const relationValidation = Table.validateRelations(snapshot.tables)
  const validatedRelations = Effect.mapError(relationValidation, relationFailure)

  return Effect.as(validatedRelations, snapshot)
}

const validateMigrationSnapshots = Effect.fn("SqliteMigrations.validateMigrationSnapshots")(
  function* (migration: SqliteMigration) {
    yield* validateSnapshot(migration.from)
    yield* validateSnapshot(migration.to)

    const expressions = pipe(
      migration.steps,
      Array.filter(Schema.is(SqliteRebuildTable)),
      Array.flatMap(Struct.get("copies")),
      Array.filter(Schema.is(SqliteColumnExpression)),
    )

    const invalidCopy = (copy: SqliteColumnExpression) => !sqlExpressionIsValid(copy.expression)
    const invalidExpression = Array.some(expressions, invalidCopy)

    if (invalidExpression) {
      return yield* migrationFailure("migration copy expressions must be single SQL expressions")
    }

    return migration
  },
)

const SqliteMigrationJsonSchema = Schema.toCodecJson(SqliteMigration)
const SqliteMigrationSourceSchema = Schema.fromJsonString(SqliteMigrationJsonSchema)
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


const decodeMigration = (source: string) =>
  pipe(
    Schema.decodeUnknownEffect(SqliteMigrationSourceSchema)(source),
    Effect.mapError((cause) => migrationFailure("invalid SQLite migration artifact", cause)),
    Effect.flatMap(validateMigrationSnapshots),
    Effect.map(freeze),
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
  const ledgerTable = quoteIdentifier(LedgerTable)
  const createLedger = `CREATE TABLE IF NOT EXISTS ${ledgerTable} (position INTEGER PRIMARY KEY NOT NULL, id TEXT UNIQUE NOT NULL, artifact TEXT NOT NULL)`
  return applyStatement(sql, createLedger)
}

const enableForeignKeys = (sql: SqlClient.SqlClient) =>
  applyStatement(sql, "PRAGMA foreign_keys = ON")

const SqliteNullableStringSchema = Schema.NullOr(Schema.String)
const SqliteTableObjectRowSchema = Schema.Struct({ name: Schema.String })
interface SqliteTableObjectRow extends Schema.Schema.Type<typeof SqliteTableObjectRowSchema> {}

const SqliteSchemaObjectRowSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["index", "trigger"]),
  sql: SqliteNullableStringSchema,
})

interface SqliteSchemaObjectRow extends Schema.Schema.Type<typeof SqliteSchemaObjectRowSchema> {}

const SqliteMigrationRowSchema = Schema.Struct({
  id: Schema.String,
  artifact: Schema.String,
})

interface SqliteMigrationRow extends Schema.Schema.Type<typeof SqliteMigrationRowSchema> {}
const SqliteTableSqlRowSchema = Schema.Struct({ sql: SqliteNullableStringSchema })
interface SqliteTableSqlRow extends Schema.Schema.Type<typeof SqliteTableSqlRowSchema> {}
const SqliteTableObjectRowsSchema = Schema.Array(SqliteTableObjectRowSchema)
const SqliteSchemaObjectRowsSchema = Schema.Array(SqliteSchemaObjectRowSchema)
const SqliteMigrationRowsSchema = Schema.Array(SqliteMigrationRowSchema)
const SqliteTableSqlRowsSchema = Schema.Array(SqliteTableSqlRowSchema)
const SqliteForeignKeyCheckRowsSchema = Schema.Array(Schema.Unknown)

const statementPair = ([index, statement]: readonly [DeclaredIndex, string]) =>
  [index.name, statement] as const

const schemaObjectEntry = (object: SqliteSchemaObjectRow) => [object.name, object] as const

const checkTableObjectDrift = Effect.fn("SqliteMigrations.checkTableObjectDrift")(function* (
  sql: SqlClient.SqlClient,
  table: TableSnapshot,
) {
  const expectedIndexes = declaredIndexes(table)
  const statements = renderCreateIndexes(table)
  const expectedPairs = Array.zip(expectedIndexes, statements)
  const expectedEntries = Array.map(expectedPairs, statementPair)
  const expectedStatements = HashMap.fromIterable(expectedEntries)
  const triggerEquals = Equivalence.strictEqual<string>()
  const isTrigger = (type: string) => triggerEquals(type, "trigger")

  const unexpectedObject = (object: SqliteSchemaObjectRow) => {
    const untracked = !HashMap.has(expectedStatements, object.name)
    return isTrigger(object.type) || untracked
  }

  const sqlMatchesExpected = (object: SqliteSchemaObjectRow) => (expectedSql: string) => {
    const actualSql = pipe(Option.fromNullishOr(object.sql), Option.map(normalizedSql))
    const normalizedExpectedSql = normalizedSql(expectedSql)
    const sqlEquals = Equivalence.strictEqual<string>()
    const matchesSql = (statement: string) => sqlEquals(statement, normalizedExpectedSql)
    return Option.exists(actualSql, matchesSql)
  }

  const matchingObjectSql = (object: SqliteSchemaObjectRow) =>
    pipe(
      HashMap.get(expectedStatements, object.name),
      Option.exists(sqlMatchesExpected(object)),
    )

  const checkObjectDrift = Effect.fn("SqliteMigrations.checkObjectDrift")(function* (
    objects: ReadonlyArray<SqliteSchemaObjectRow>,
  ) {
    const actualEntries = Array.map(objects, schemaObjectEntry)
    const actualObjects = HashMap.fromIterable(actualEntries)
    const hasUntrackedObject = Array.some(objects, unexpectedObject)

    if (hasUntrackedObject) {
      return yield* migrationFailure(
        `SQLite contains untracked indexes or triggers for table ${table.name}`,
      )
    }

    const allObjectSqlMatches = Array.every(objects, matchingObjectSql)

    if (!allObjectSqlMatches) {
      return yield* migrationFailure(`SQLite schema drift detected for table ${table.name}`)
    }

    const expectedIndexExists = (index: DeclaredIndex) =>
      HashMap.has(actualObjects, index.name)

    const allIndexesExist = Array.every(expectedIndexes, expectedIndexExists)

    if (!allIndexesExist) {
      return yield* migrationFailure(`SQLite schema drift detected for table ${table.name}`)
    }
  })

  const inspectionFailure = (cause: unknown) =>
    Schema.is(MigrationError)(cause)
      ? cause
      : migrationFailure(`could not inspect table ${table.name}`, cause)

  const objectsQuery = sql`SELECT name, type, sql FROM sqlite_master
    WHERE tbl_name = ${table.name} AND type IN ('index', 'trigger')
      AND name NOT LIKE 'sqlite_autoindex_%'`

  const decodedObjects = Effect.flatMap(
    objectsQuery,
    Schema.decodeUnknownEffect(SqliteSchemaObjectRowsSchema),
  )

  const verifiedObjects = Effect.flatMap(decodedObjects, checkObjectDrift)

  yield* Effect.mapError(verifiedObjects, inspectionFailure)
})

const foreignKeyFailure = (cause: unknown) =>
  Schema.is(MigrationError)(cause)
    ? cause
    : migrationFailure("could not validate SQLite foreign keys", cause)

const validateForeignKeyRows = (rows: ReadonlyArray<unknown>) => {
  const noForeignKeyViolations = Equivalence.strictEqual<number>()(rows.length, 0)

  if (noForeignKeyViolations) {
    return Effect.void
  }

  const failure = migrationFailure("SQLite foreign key validation failed")
  return Effect.fail(failure)
}

const verifyForeignKeys = (sql: SqlClient.SqlClient) => {
  const query = sql`PRAGMA foreign_key_check`

  const decodedRows = Effect.flatMap(
    query,
    Schema.decodeUnknownEffect(SqliteForeignKeyCheckRowsSchema),
  )

  const validatedRows = Effect.flatMap(decodedRows, validateForeignKeyRows)

  return Effect.mapError(validatedRows, foreignKeyFailure)
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
  const expectedEntries = Array.map(snapshot.tables, migrationTableEntry)
  const tableEntryName = ([name]: readonly [string, TableSnapshot]) => name
  const expectedNames = Array.map(expectedEntries, tableEntryName)
  const expected = HashSet.fromIterable(expectedNames)
  const expectedCount = HashSet.size(expected)
  const matchingTableCount = Equivalence.strictEqual<number>()(names.length, expectedCount)
  const tableIsExpected = (name: string) => HashSet.has(expected, name)
  const everyTableIsExpected = Array.every(names, tableIsExpected)
  const tablesMatch = matchingTableCount && everyTableIsExpected

  if (!tablesMatch) {
    return yield* migrationFailure("SQLite contains tables not tracked by the schema migration history")
  }

  const verifyTable = Effect.fn("SqliteMigrations.verifyTable")(function* (table: TableSnapshot) {
    yield* checkTableObjectDrift(sql, table)
    const actual = yield* tableSql(sql, table.name)

    if (!Predicate.isString(actual)) {
      return yield* migrationFailure(`SQLite schema drift detected for table ${table.name}`)
    }

    const actualSql = normalizedSql(actual)
    const expectedTableSql = renderCreateTable(table)
    const expectedSql = normalizedSql(expectedTableSql)
    const sqlEquals = Equivalence.strictEqual<string>()

    if (sqlEquals(actualSql, expectedSql)) {
      return
    }

    // SQLite appends added columns because named records are declaration-order independent.
    const columnsQuery = sql`SELECT name FROM pragma_table_info(${table.name}) ORDER BY cid`
    const decodedColumns = Effect.flatMap(columnsQuery, decodeColumns)

    const columnInspectionFailure = (cause: unknown) =>
      migrationFailure(`could not inspect columns for ${table.name}`, cause)

    const columns = yield* Effect.mapError(decodedColumns, columnInspectionFailure)
    const fields = fieldMap(table)
    const fieldOptionForColumn = (column: SqliteTableObjectRow) => HashMap.get(fields, column.name)
    const orderedFieldOptions = Array.map(columns, fieldOptionForColumn)
    const missingField = Array.some(orderedFieldOptions, Option.isNone)

    if (missingField) {
      return yield* migrationFailure(`SQLite schema drift detected for table ${table.name}`)
    }

    const orderedFields = Array.getSomes(orderedFieldOptions)
    const physicalTable = TableSnapshot.make({ ...table, fields: orderedFields })

    const matchingFieldCount = Equivalence.strictEqual<number>()(
      orderedFields.length,
      table.fields.length,
    )

    const physicalTableSql = renderCreateTable(physicalTable)
    const physicalSql = normalizedSql(physicalTableSql)
    const physicalTableMatches = sqlEquals(actualSql, physicalSql)
    const matchingPhysicalTable = matchingFieldCount && physicalTableMatches

    if (!matchingPhysicalTable) {
      return yield* migrationFailure(`SQLite schema drift detected for table ${table.name}`)
    }
  })

  yield* Effect.forEach(snapshot.tables, verifyTable, { discard: true })
  yield* verifyForeignKeys(sql)
})

const rebuildTable = Effect.fn("SqliteMigrations.rebuildTable")(function* (
  sql: SqlClient.SqlClient,
  rebuild: SqliteRebuildTable,
) {
  const temporary = `__effect_schema_${rebuild.table.name}`
  const temporaryTable = TableSnapshot.make({ ...rebuild.table, name: temporary })
  const columns = pipe(rebuild.copies, Array.map(flow(Struct.get("column"), quoteIdentifier)), Array.join(", "))
  const sourceSql = (source: SqliteColumnSource) => pipe(source.source, quoteIdentifier, sql.literal)

  const valueSql = (value: SqliteColumnValue) => {
    const parameter = Statement.parameter(value.value)
    return Statement.fragment([parameter])
  }

  const expressionSql = (expression: SqliteColumnExpression) =>
    sql.literal(expression.expression)

  const sqlFragment = (copy: SqliteColumnSource | SqliteColumnValue | SqliteColumnExpression) =>
    pipe(
      Match.value(copy),
      Match.tagsExhaustive({
        SqliteColumnSource: sourceSql,
        SqliteColumnValue: valueSql,
        SqliteColumnExpression: expressionSql,
      }),
    )

  const expressions = pipe(rebuild.copies, Array.map(sqlFragment), sql.join(", ", false))
  const quotedTemporary = quoteIdentifier(temporary)
  const quotedSource = quoteIdentifier(rebuild.table.name)
  const create = renderCreateTable(temporaryTable)
  yield* applyStatement(sql, create)

  yield* pipe(
    sql`INSERT INTO ${sql.literal(quotedTemporary)} (${sql.literal(columns)}) SELECT ${expressions} FROM ${sql.literal(quotedSource)}`,
    Effect.asVoid,
    Effect.mapError((cause) => migrationFailure("SQLite schema operation failed", cause)),
  )

  yield* applyStatement(sql, `DROP TABLE ${quotedSource}`)
  yield* applyStatement(sql, `ALTER TABLE ${quotedTemporary} RENAME TO ${quotedSource}`)
})

const runStep = Effect.fn("SqliteMigrations.runStep")(function* (
  sql: SqlClient.SqlClient,
  step: SqliteMigrationStep,
) {
  if (Predicate.isTagged(step, "SqliteRebuildTable")) {
    return yield* rebuildTable(sql, step)
  }

  const statement = pipe(
    Match.value(step),
    Match.tagsExhaustive({
      SqliteCreateTable: (create) => renderCreateTable(create.table),
      SqliteAddColumn: (addition) =>
        `ALTER TABLE ${quoteIdentifier(addition.table)} ADD COLUMN ${renderColumn(addition.column, false)}`,
      SqliteRenameColumn: (rename) =>
        `ALTER TABLE ${quoteIdentifier(rename.table)} RENAME COLUMN ${quoteIdentifier(rename.from)} TO ${quoteIdentifier(rename.to)}`,
      SqliteCreateIndex: (create) => renderIndex(create.table)(create),
      SqliteDropIndex: (drop) => `DROP INDEX ${quoteIdentifier(drop.name)}`,
    }),
  )

  return yield* applyStatement(sql, statement)
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
    yield* applyStatement(sql, "PRAGMA defer_foreign_keys = ON")
    yield* Effect.forEach(migration.steps, applyStep, { discard: true })
    yield* verifyDatabase(sql, migration.to)
    // Clear this flag before COMMIT because SQLite retains its deferred-constraint counter after a parent rebuild.
    yield* applyStatement(sql, "PRAGMA defer_foreign_keys = OFF")
    yield* recordMigration(sql, migration, position)
  })

  const replayEffect = replayMigration()
  const transaction = sql.withTransaction(replayEffect)
  return pipe(transaction, Effect.mapError(migrationError))
}

const validateHistory = Effect.fn("SqliteMigrations.validateHistory")(function* (
  migrations: ReadonlyArray<SqliteMigration>,
) {
  const initialSnapshot = emptySnapshot()
  const initialSeen = HashSet.empty<string>()
  const initialState = [initialSnapshot, initialSeen] as const
  const initial = Effect.succeed(initialState)

  const validateMigration = (
    accumulated: Effect.Effect<readonly [SqliteSchemaSnapshot, HashSet.HashSet<string>], MigrationError>,
    migration: SqliteMigration,
  ) =>
    pipe(
      accumulated,
      Effect.flatMap(([previous, seen]) => {
        const emptyId = Equivalence.strictEqual<number>()(migration.id.length, 0)
        const duplicateId = HashSet.has(seen, migration.id)
        const invalidId = emptyId || duplicateId

        if (invalidId) {
          const error = migrationFailure("migration ids must be unique non-empty strings")
          return Effect.fail(error)
        }

        const fromIdentifierErrors = identifiers(migration.from)
        const toIdentifierErrors = identifiers(migration.to)
        const identityErrors = Array.appendAll(fromIdentifierErrors, toIdentifierErrors)
        const hasIdentityErrors = !Equivalence.strictEqual<number>()(identityErrors.length, 0)

        if (hasIdentityErrors) {
          const identifierMessage = Array.join(identityErrors, "; ")
          const error = migrationFailure(identifierMessage)
          return Effect.fail(error)
        }

        const precedesPrevious = snapshotEquals(previous, migration.from)

        if (!precedesPrevious) {

          const error = migrationFailure(
            `migration ${migration.id} does not begin at the preceding frozen snapshot`,
          )

          return Effect.fail(error)
        }

        const nextSeen = HashSet.add(seen, migration.id)
        const nextState = [migration.to, nextSeen] as const
        return pipe(validateMigrationSnapshots(migration), Effect.as(nextState))
      }),
    )

  yield* Array.reduce(migrations, initial, validateMigration)
  return freeze(migrations)
})

const decodeHistory = (raw: unknown) =>
  pipe(
    Schema.decodeUnknownEffect(SqliteMigrationHistorySchema)(raw),
    Effect.flatMap(validateHistory),
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
    return yield* validateHistory(migrations)
  },
)

const make = (input: Readonly<{
  id: string
  from: SqliteSchemaSnapshot
  to: SqliteSchemaSnapshot
  steps: ReadonlyArray<SqliteMigrationStep>
}>): SqliteMigration => {
  const migration = SqliteMigration.make(input)

  const validate = Effect.gen(function* () {
    if (Equivalence.strictEqual<number>()(migration.id.length, 0)) {
      return yield* migrationFailure("migration id must not be empty")
    }

    return yield* validateMigrationSnapshots(migration)
  })

  return pipe(validate, Effect.map(freeze), Effect.runSync)
}

const initial = (options: Readonly<{ id: string; tables: ReadonlyArray<Table> }>) => {
  const to = snapshotFromTable(options.tables)
  const createTable = (table: TableSnapshot) => SqliteCreateTable.make({ table })

  const createIndexes = (table: TableSnapshot) => {
    const createIndex = (index: DeclaredIndex) => SqliteCreateIndex.make({ table: table.name, ...index })
    return pipe(declaredIndexes(table), Array.map(createIndex))
  }

  const tables = Array.map(to.tables, createTable)
  const indexes = Array.flatMap(to.tables, createIndexes)
  const from = emptySnapshot()
  return make({ id: options.id, from, to, steps: [...tables, ...indexes] })
}

/** Explicit migration artifacts. Schema changes and copy semantics are authored, never inferred. */
export const SqliteMigrations = {
  steps: {
    CreateTable: SqliteCreateTable,
    AddColumn: SqliteAddColumn,
    RenameColumn: SqliteRenameColumn,
    RebuildTable: SqliteRebuildTable,
    CreateIndex: SqliteCreateIndex,
    DropIndex: SqliteDropIndex,
  },
  copies: {
    Source: SqliteColumnSource,
    Value: SqliteColumnValue,
    Expression: SqliteColumnExpression,
  },
  make,
  initial,
  snapshot: snapshotFromTable,
  decodeHistory,
  load: Effect.fn("SqliteMigrations.load")(function* (manifest: string) {
    return yield* readMigrationManifest(manifest)
  }),
}

export const makeMigrationStore = (
  sql: SqlClient.SqlClient,
  migrations: ReadonlyArray<SqliteMigration>,
) =>
  SchemaStore.of({
    prepare: Effect.fn("SchemaStore.prepare")(function* (tables) {
      const target = schemaSnapshot(tables)
      yield* enableForeignKeys(sql)
      yield* validateSnapshot(target)
      yield* validateHistory(migrations)

      const lastMigration = Array.get(migrations, migrations.length - 1)

      const expectedTarget = Option.match(lastMigration, {
        onNone: emptySnapshot,
        onSome: Struct.get("to"),
      })

      const hasNoMigrations = Equivalence.strictEqual<number>()(migrations.length, 0)
      const hasApplicationTables = !Equivalence.strictEqual<number>()(target.tables.length, 0)
      const missingInitialHistory = hasNoMigrations && hasApplicationTables

      if (missingInitialHistory) {
        return yield* migrationFailure("nonempty application schemas require an initial migration history")
      }

      if (!snapshotEquals(expectedTarget, target)) {
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
        const artifactsMatch = Equivalence.strictEqual<string>()(recorded.artifact, suppliedArtifact)
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
      const expectedCurrent = hasEmptyLedger ? emptySnapshot() : Option.match(previousMigration, { onNone: emptySnapshot, onSome: Struct.get("to") })
      yield* verifyDatabase(sql, expectedCurrent)

      const pendingMigrations = Array.drop(migrations, ledger.length)
      const applyPendingMigration = (migration: SqliteMigration, index: number) => applyMigration(sql, migration, index + ledger.length)

      yield* Effect.forEach(pendingMigrations, applyPendingMigration, { discard: true })
      return yield* verifyDatabase(sql, target)
    }),
  })
