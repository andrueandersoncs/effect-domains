import { Array, Effect, Equivalence, FileSystem, flow, Function, HashMap, HashSet, Match, Option, Order, pipe, Predicate, Record, Result, Schema, Stdio, Stream, Struct } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import { SqlClient, Statement } from "effect/unstable/sql"
import { MigrationError, SchemaStore } from "./migrations.ts"

import {
  Table,
  TableCheckSchema,
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

class SqliteRename extends Schema.Class<SqliteRename>("SqliteRename")({
  table: Schema.String,
  from: Schema.String,
  to: Schema.String,
}) {}

class SqliteBackfill extends Schema.Class<SqliteBackfill>("SqliteBackfill")({
  table: Schema.String,
  column: Schema.String,
  value: MigrationValueSchema,
}) {}

/**
 * `expression` is evaluated against physical `from` columns because rebuilding
 * or renaming the table would otherwise change the expression's meaning.
 */
class SqliteTransform extends Schema.Class<SqliteTransform>("SqliteTransform")({
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

class SqliteBlockedChange extends Schema.TaggedClass<SqliteBlockedChange>()(
  "SqliteBlockedChange",
  { reason: Schema.String },
) {}

const SqliteMigrationStepSchema = Schema.Union([
  SqliteCreateTable,
  SqliteAddColumn,
  SqliteRenameColumn,
  SqliteRebuildTable,
  SqliteCreateIndex,
  SqliteDropIndex,
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

const SqliteRenameIntentSchema = Schema.Struct({
  table: Schema.String,
  from: Schema.String,
  to: Schema.String,
})

interface SqliteRenameIntent extends Schema.Schema.Type<typeof SqliteRenameIntentSchema> {}

const SqliteBackfillIntentSchema = Schema.Struct({
  table: Schema.String,
  column: Schema.String,
  value: MigrationValueSchema,
})

interface SqliteBackfillIntent extends Schema.Schema.Type<typeof SqliteBackfillIntentSchema> {}

const SqliteTransformIntentSchema = Schema.Struct({
  table: Schema.String,
  column: Schema.String,
  expression: Schema.String,
})

interface SqliteTransformIntent extends Schema.Schema.Type<typeof SqliteTransformIntentSchema> {}
const SqliteRenameIntentsSchema = Schema.Array(SqliteRenameIntentSchema)
const SqliteBackfillIntentsSchema = Schema.Array(SqliteBackfillIntentSchema)
const SqliteTransformIntentsSchema = Schema.Array(SqliteTransformIntentSchema)
const OptionalSqliteRenameIntentsSchema = Schema.optionalKey(SqliteRenameIntentsSchema)
const OptionalSqliteBackfillIntentsSchema = Schema.optionalKey(SqliteBackfillIntentsSchema)
const OptionalSqliteTransformIntentsSchema = Schema.optionalKey(SqliteTransformIntentsSchema)

class SqliteMigrationPlanningConfig extends Schema.Class<SqliteMigrationPlanningConfig>(
  "SqliteMigrationPlanningConfig",
)({
  id: Schema.String,
  from: SqliteSchemaSnapshot,
  to: SqliteSchemaSnapshot,
  renames: OptionalSqliteRenameIntentsSchema,
  backfills: OptionalSqliteBackfillIntentsSchema,
  transforms: OptionalSqliteTransformIntentsSchema,
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

const fieldMetadataEquals = pipe(
  Schema.Struct({
    scalar: Schema.Literals(["string", "integer", "number"]),
    nullable: Schema.Boolean,
    generation: Schema.Option(Schema.Literal("uuidv7")),
    checks: Schema.Array(TableCheckSchema),
  }),
  Schema.toEquivalence,
)

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

const fieldMetadata = (field: TableField) => {
  const { _tag: _, name: __, ...metadata } = field
  return metadata
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

const blocked = flow((reason: string) => SqliteBlockedChange.make({ reason }), freeze)

const normalizedFieldEquals = (left: TableField, right: TableField) => {
  const leftMetadata = fieldMetadata(left)
  const rightMetadata = fieldMetadata(right)
  return fieldMetadataEquals(leftMetadata, rightMetadata)
}

const intentMap = <A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
) => {
  const entryForValue = (value: A) => [key(value), value] as const
  return pipe(values, Array.map(entryForValue), HashMap.fromIterable)
}

const snapshotFromTable = flow(Array.map(Table.snapshot), schemaSnapshot)

const normalizedSql = (sql: string) => {
  const tokens = sql.trim().replace(/;$/, "").match(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[^\s]/g,
  ) ?? []

  return Array.join(tokens, "\u0000")
}

const relationText = (value: unknown) => {
  const option = Option.fromUndefinedOr(value)

  return Option.match(option, {
    onNone: Function.constant(""),
    onSome: canonicalText,
  })
}

const constraintText = (table: TableSnapshot) =>
  relationText({
    unique: table.relations?.unique ?? [],
    foreignKeys: table.relations?.foreignKeys ?? [],
  })

const constraintsEqual = (source: TableSnapshot, target: TableSnapshot) => {
  const sourceText = constraintText(source)
  const targetText = constraintText(target)
  const equals = Equivalence.strictEqual<string>()

  return equals(sourceText, targetText)
}

const declaredIndexes = (table: TableSnapshot) => table.relations?.indexes ?? []
type DeclaredIndex = ReturnType<typeof declaredIndexes>[number]

const sameIndexDescription = (
  source: DeclaredIndex,
  target: DeclaredIndex,
) => {
  const sourceText = relationText(source)
  const targetText = relationText(target)
  const equals = Equivalence.strictEqual<string>()

  return equals(sourceText, targetText)
}


const migrationFailure = (reason: string, cause: unknown = undefined): MigrationError => {
  const firstCause = Option.fromUndefinedOr(cause)
  const failureWithoutCause = MigrationError.make({ reason })

  return Option.match(firstCause, {
    onNone: Function.constant(failureWithoutCause),
    onSome: (value) => MigrationError.make({ reason, cause: value }),
  })
}

const relationFailure = (cause: Effect.Error<ReturnType<typeof Table.validateRelations>>) =>
  migrationFailure(cause.message, cause)

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

    return migration
  },
)

const SqliteSnapshotJsonSchema = Schema.toCodecJson(SqliteSchemaSnapshot)

const snapshotRelationErrors = (snapshot: SqliteSchemaSnapshot) => {
  const relationValidation = Table.validateRelations(snapshot.tables)
  const resultEffect = Effect.result(relationValidation)
  const result = Effect.runSync(resultEffect)

  return Result.isFailure(result) ? [result.failure.message] : []
}

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


const decodeMigration = (source: string) =>
  pipe(
    Schema.decodeUnknownEffect(SqliteMigrationSourceSchema)(source),
    Effect.mapError((cause) => migrationFailure("invalid SQLite migration artifact", cause)),
    Effect.flatMap(validateMigrationSnapshots),
    Effect.map(freeze),
  )

const migrationTo = (migration: SqliteMigration) => freeze(migration.to)
const decodeMigrationTarget = flow(decodeMigration, Effect.map(migrationTo))

const decodeSource = (source: string) =>
  pipe(
    Schema.decodeUnknownEffect(SqliteSnapshotSourceSchema)(source),
    Effect.matchEffect({
      onFailure: () => decodeMigrationTarget(source),
      onSuccess: flow(validateSnapshot, Effect.map(freeze)),
    }),
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
  const expectedEntries = Array.map(snapshot.tables, tableEntry)
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

const runStep = Effect.fn("SqliteMigrations.runStep")(function* (
  sql: SqlClient.SqlClient,
  step: SqliteMigrationStep,
) {
  const rebuildTable = Effect.fn("SqliteMigrations.rebuildTable")(function* (
    rebuild: SqliteRebuildTable,
  ) {
    const temporary = `__effect_schema_${rebuild.table.name}`
    const temporaryTable = TableSnapshot.make({ ...rebuild.table, name: temporary })
    const copiedColumns = Array.map(rebuild.copies, Struct.get("column"))
    const quotedColumns = Array.map(copiedColumns, quoteIdentifier)
    const columns = Array.join(quotedColumns, ", ")

    const sourceSql: (source: SqliteColumnSource) => ReturnType<typeof sql.literal> =
      flow(Struct.get("source"), quoteIdentifier, sql.literal)

    const sqlFragment = (
      copy: SqliteColumnSource | SqliteColumnValue | SqliteColumnExpression,
    ) =>
      pipe(
        Match.value(copy),
        Match.tagsExhaustive({
          SqliteColumnSource: sourceSql,
          SqliteColumnValue: (value) => {
            const parameter = Statement.parameter(value.value)
            return Statement.fragment([parameter])
          },
          SqliteColumnExpression: (value) => sql.literal(value.expression),
        }),
      )

    const expressionFragments = Array.map(rebuild.copies, sqlFragment)
    const expressions = sql.join(", ", false)(expressionFragments)
    const columnsFragment = sql.literal(columns)
    const quotedTemporary = quoteIdentifier(temporary)
    const temporaryFragment = sql.literal(quotedTemporary)
    const quotedSource = quoteIdentifier(rebuild.table.name)
    const sourceFragment = sql.literal(quotedSource)
    const createTemporaryTable = renderCreateTable(temporaryTable)

    yield* applyStatement(sql, createTemporaryTable)

    const copyQuery = sql`INSERT INTO ${temporaryFragment} (${columnsFragment}) SELECT ${expressions} FROM ${sourceFragment}`
    const copiedRows = Effect.asVoid(copyQuery)
    const copyFailure = (cause: unknown) => migrationFailure("SQLite schema operation failed", cause)

    yield* Effect.mapError(copiedRows, copyFailure)
    yield* applyStatement(sql, `DROP TABLE ${quotedSource}`)
    yield* applyStatement(sql, `ALTER TABLE ${quotedTemporary} RENAME TO ${quotedSource}`)
  })

  const createTable = (create: SqliteCreateTable) => {
    const statement = renderCreateTable(create.table)

    return applyStatement(sql, statement)
  }

  const addColumn = (addition: SqliteAddColumn) => {
    const table = quoteIdentifier(addition.table)
    const column = renderColumn(addition.column, false)
    const statement = `ALTER TABLE ${table} ADD COLUMN ${column}`

    return applyStatement(sql, statement)
  }

  const renameColumn = (rename: SqliteRenameColumn) => {
    const table = quoteIdentifier(rename.table)
    const from = quoteIdentifier(rename.from)
    const to = quoteIdentifier(rename.to)
    const statement = `ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`

    return applyStatement(sql, statement)
  }

  const createIndex = (create: SqliteCreateIndex) => {
    const statement = renderIndex(create.table)(create)
    return applyStatement(sql, statement)
  }

  const dropIndex = (drop: SqliteDropIndex) => {
    const name = quoteIdentifier(drop.name)
    const statement = `DROP INDEX ${name}`

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
      SqliteCreateIndex: createIndex,
      SqliteDropIndex: dropIndex,
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

        const hasBlockedChange = Array.some(migration.steps, Schema.is(SqliteBlockedChange))

        if (hasBlockedChange) {
          const error = migrationFailure(`migration ${migration.id} contains unresolved changes`)
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

const LoadedMigrationEntriesSchema = Schema.Array(Schema.String)
const LoadedMigrationsSchema = Schema.Array(SqliteMigration)

class LoadedSqliteMigrationManifest extends Schema.Class<LoadedSqliteMigrationManifest>(
  "LoadedSqliteMigrationManifest",
)({
  entries: LoadedMigrationEntriesSchema,
  migrations: LoadedMigrationsSchema,
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
    const validatedMigrations = yield* validateHistory(migrations)

    const loadedManifest = LoadedSqliteMigrationManifest.make({
      entries,
      migrations: validatedMigrations,
    })

    return freeze(loadedManifest)
  },
)

const invalidIntent = (flag: string, input: string, format: string) =>
  CliError.UserError.make({
    cause: migrationFailure(`invalid ${flag} intent`),
    userMessage: `${flag} must be ${format}: ${input}`,
  })

const parseSqliteRename = (input: string) => {
  const parts = input.split(":")
  const hasExpectedParts = Equivalence.strictEqual<number>()(parts.length, 3)
  const partIsEmpty = (part: string) => Equivalence.strictEqual<number>()(part.length, 0)
  const hasEmptyPart = Array.some(parts, partIsEmpty)
  const missingExpectedParts = !hasExpectedParts
  const invalidParts = missingExpectedParts || hasEmptyPart

  if (invalidParts) {
    const error = invalidIntent("--rename", input, "table:from:to")
    return Effect.fail(error)
  }

  const [table, from, to] = parts as [string, string, string]
  const rename = SqliteRename.make({ table, from, to })
  const frozenRename = freeze(rename)
  return Effect.succeed(frozenRename)
}

const MigrationValueSourceSchema = Schema.fromJsonString(MigrationValueSchema)

const parseSqliteBackfill = (input: string) => {
  const first = input.indexOf(":")
  const second = input.indexOf(":", first + 1)
  const missingTable = first <= 0
  const missingColumn = second <= first + 1
  const invalidParts = missingTable || missingColumn

  if (invalidParts) {
    const error = invalidIntent("--backfill", input, "table:column:JSON-value")
    return Effect.fail(error)
  }

  const table = input.slice(0, first)
  const column = input.slice(first + 1, second)
  const valueSource = input.slice(second + 1)
  const createBackfill = (value: string | number | null) => SqliteBackfill.make({ table, column, value })
  const makeBackfill = flow(createBackfill, freeze)

  return pipe(
    Schema.decodeUnknownEffect(MigrationValueSourceSchema)(valueSource),
    Effect.mapError(() => invalidIntent("--backfill", input, "table:column:JSON-value")),
    Effect.map(makeBackfill),
  )
}

const parseSqliteTransform = (input: string) => {
  const first = input.indexOf(":")
  const second = input.indexOf(":", first + 1)
  const missingTable = first <= 0
  const missingColumn = second <= first + 1
  const invalidParts = missingTable || missingColumn

  if (invalidParts) {
    const error = invalidIntent("--transform", input, "table:column:SQL-expression")
    return Effect.fail(error)
  }

  const table = input.slice(0, first)
  const column = input.slice(first + 1, second)
  const expression = input.slice(second + 1)
  const parsedTransform = SqliteTransform.make({ table, column, expression })
  const transform = freeze(parsedTransform)
  const expressionIsValid = sqlExpressionIsValid(transform.expression)

  if (expressionIsValid) {
    return Effect.succeed(transform)
  }

  const error = invalidIntent("--transform", input, "table:column:SQL-expression")
  return Effect.fail(error)
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

class ColumnFieldSource extends Schema.TaggedClass<ColumnFieldSource>()(
  "Column",
  { field: TableField },
) {}

class TransformFieldSource extends Schema.TaggedClass<TransformFieldSource>()(
  "Transform",
  { intent: SqliteTransform },
) {}

class BackfillFieldSource extends Schema.TaggedClass<BackfillFieldSource>()(
  "Backfill",
  { intent: SqliteBackfill },
) {}

class NullableFieldSource extends Schema.TaggedClass<NullableFieldSource>()("Nullable", {}) {}
class BlockedFieldSource extends Schema.TaggedClass<BlockedFieldSource>()("Blocked", {}) {}

const FieldSourceSchema = Schema.Union([
  ColumnFieldSource,
  TransformFieldSource,
  BackfillFieldSource,
  NullableFieldSource,
  BlockedFieldSource,
])

const FieldPlanSourceFieldSchema = Schema.Option(TableField)
const FieldPlanErrorsSchema = Schema.Array(Schema.String)
const FieldPlanUsedRenameSchema = Schema.Option(SqliteRename)
const TablePlanStepsSchema = Schema.Array(SqliteMigrationStepSchema)
const TablePlanErrorsSchema = Schema.Array(Schema.String)
const TablePlanUsedRenamesSchema = Schema.Array(SqliteRename)
const TablePlanUsedBackfillsSchema = Schema.Array(SqliteBackfill)
const TablePlanUsedTransformsSchema = Schema.Array(SqliteTransform)

class FieldPlan extends Schema.Class<FieldPlan>("FieldPlan")({
  target: TableField,
  sourceField: FieldPlanSourceFieldSchema,
  valueSource: FieldSourceSchema,
  errors: FieldPlanErrorsSchema,
  usedRename: FieldPlanUsedRenameSchema,
}) {}

class TablePlan extends Schema.Class<TablePlan>("TablePlan")({
  steps: TablePlanStepsSchema,
  errors: TablePlanErrorsSchema,
  usedRenames: TablePlanUsedRenamesSchema,
  usedBackfills: TablePlanUsedBackfillsSchema,
  usedTransforms: TablePlanUsedTransformsSchema,
}) {}

const interactingRenamesRequireRebuild = (renames: ReadonlyArray<SqliteRename>) => {
  const isEffectiveRename = (rename: SqliteRename) =>
    !Equivalence.strictEqual<string>()(rename.from, rename.to)

  const effectiveRenames = Array.filter(renames, isEffectiveRename)
  const sourceNames = pipe(effectiveRenames, Array.map(Struct.get("from")), HashSet.fromIterable)
  const occupiesSource = (rename: SqliteRename) => HashSet.has(sourceNames, rename.to)
  return Array.some(effectiveRenames, occupiesSource)
}

const planSqliteMigration = (input: SqliteMigrationPlanningConfig) => {
  const options = SqliteMigrationPlanningConfig.make(input)
  const requestedRenames = Option.fromUndefinedOr(options.renames)
  const requestedBackfills = Option.fromUndefinedOr(options.backfills)
  const requestedTransforms = Option.fromUndefinedOr(options.transforms)
  const makeRename = (intent: SqliteRenameIntent) => SqliteRename.make(intent)
  const makeBackfill = (intent: SqliteBackfillIntent) => SqliteBackfill.make(intent)
  const makeTransform = (intent: SqliteTransformIntent) => SqliteTransform.make(intent)
  const normalizedRenames = Option.map(requestedRenames, Array.map(makeRename))
  const normalizedBackfills = Option.map(requestedBackfills, Array.map(makeBackfill))
  const normalizedTransforms = Option.map(requestedTransforms, Array.map(makeTransform))
  const renames = Option.getOrElse(normalizedRenames, Function.constant([]))
  const backfills = Option.getOrElse(normalizedBackfills, Function.constant([]))
  const transforms = Option.getOrElse(normalizedTransforms, Function.constant([]))
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

    const createTablePlan = (): TablePlan => {
      const creation = SqliteCreateTable.make({ table: target })

      return TablePlan.make({
        steps: [freeze(creation)],
        errors: [],
        usedRenames: [],
        usedBackfills: [],
        usedTransforms: [],
      })
    }

    const modifyTablePlan = (source: TableSnapshot): TablePlan => {
      const sourceFields = fieldMap(source)

      const planField = (targetField: TableField): FieldPlan => {
        const key = `${target.name}\u0000${targetField.name}`
        const rename = HashMap.get(renamesByTarget, key)
        const transform = HashMap.get(transformsByColumn, key)
        const backfill = HashMap.get(backfillsByColumn, key)

        const sourceName = Option.match(rename, {
          onNone: Function.constant(targetField.name),
          onSome: Struct.get("from"),
        })

        const sourceField = HashMap.get(sourceFields, sourceName)
        const hasRename = Option.isSome(rename)
        const sourceIsMissing = Option.isNone(sourceField)
        const invalidRename = hasRename && sourceIsMissing
        const resolvedBackfill = invalidRename ? Option.none<SqliteBackfill>() : backfill
        const validTransform = invalidRename ? Option.none<SqliteTransform>() : Option.filter(transform, flow(Struct.get("expression"), sqlExpressionIsValid))
        const expression = Option.map(validTransform, Struct.get("expression"))
        const fieldMetadataDiffers = (field: TableField) => !normalizedFieldEquals(field, targetField)
        const sourceMetadataChanges = Option.exists(sourceField, fieldMetadataDiffers)
        const transformIsMissing = Option.isNone(expression)
        const metadataNeedsTransform = sourceMetadataChanges && transformIsMissing
        const metadataErrors = metadataNeedsTransform ? [`field ${target.name}.${targetField.name} changes storage metadata without a transform`] : []
        const sourceIsAbsent = Option.isNone(sourceField)
        const fieldIsRequired = !targetField.nullable
        const expressionIsMissing = Option.isNone(expression)
        const backfillIsMissing = Option.isNone(resolvedBackfill)
        const sourceNeedsValue = sourceIsAbsent && fieldIsRequired
        const alternativesAreMissing = expressionIsMissing && backfillIsMissing
        const requiresBackfill = sourceNeedsValue && alternativesAreMissing
        const backfillErrors = requiresBackfill ? [`field ${target.name}.${targetField.name} requires an explicit backfill or transform`] : []
        const renameErrors = invalidRename ? [`rename source ${target.name}.${sourceName} does not exist`] : []
        const errors = [...renameErrors, ...metadataErrors, ...backfillErrors]
        const nullableSource = NullableFieldSource.make({})
        const useNullable = Function.constant(nullableSource)
        const useBackfill = (intent: SqliteBackfill) => BackfillFieldSource.make({ intent })
        const useSource = (field: TableField) => ColumnFieldSource.make({ field })
        const useTransform = (intent: SqliteTransform) => TransformFieldSource.make({ intent })
        const resolveSource = () => Option.match(resolvedBackfill, { onNone: useNullable, onSome: useBackfill })
        const resolveTransform = () => Option.match(sourceField, { onNone: resolveSource, onSome: useSource })
        const resolveValueSource = () => Option.match(validTransform, { onNone: resolveTransform, onSome: useTransform })
        const hasErrors = !Equivalence.strictEqual<number>()(errors.length, 0)
        const valueSource = hasErrors ? BlockedFieldSource.make({}) : resolveValueSource()
        const usedRename = invalidRename ? Option.none<SqliteRename>() : rename
        return FieldPlan.make({ target: targetField, sourceField, valueSource, errors, usedRename })
      }

      const fieldPlans = Array.map(target.fields, planField)
      const sourceFieldOptions = Array.map(fieldPlans, flow(Struct.get("sourceField"), Option.map(Struct.get("name"))))
      const retainedSourceNames = Array.getSomes(sourceFieldOptions)
      const retainedSources = HashSet.fromIterable(retainedSourceNames)
      const retainedErrorForSource = (sourceField: TableField) => HashSet.has(retainedSources, sourceField.name) ? [] : [`field ${target.name}.${sourceField.name} would be dropped or renamed without intent`]
      const retainedErrors = Array.flatMap(source.fields, retainedErrorForSource)
      const fieldPlanIsTransform = (fieldPlan: FieldPlan) => Equivalence.strictEqual<string>()(fieldPlan.valueSource._tag, "Transform")
      const fieldPlanIsBackfill = (fieldPlan: FieldPlan) => Equivalence.strictEqual<string>()(fieldPlan.valueSource._tag, "Backfill")

      const triggersRebuild = (fieldPlan: FieldPlan) =>
        fieldPlanIsTransform(fieldPlan) || fieldPlanIsBackfill(fieldPlan)

      const usedRenameOptions = Array.map(fieldPlans, Struct.get("usedRename"))
      const usedRenames = Array.getSomes(usedRenameOptions)
      const relationChangesRequireRebuild = !constraintsEqual(source, target)
      const fieldChangesRequireRebuild = Array.some(fieldPlans, triggersRebuild)
      const renameChangesRequireRebuild = interactingRenamesRequireRebuild(usedRenames)
      const nonRelationChangesRequireRebuild = fieldChangesRequireRebuild || renameChangesRequireRebuild
      const rebuild = nonRelationChangesRequireRebuild || relationChangesRequireRebuild

      const transformsForFieldPlan = (fieldPlan: FieldPlan) => pipe(Match.value(fieldPlan.valueSource), Match.tagsExhaustive({
        Column: Function.constant([]),
        Transform: (value) => [value.intent],
        Backfill: Function.constant([]),
        Nullable: Function.constant([]),
        Blocked: Function.constant([]),
      }))

      const backfillsForFieldPlan = (fieldPlan: FieldPlan) => pipe(Match.value(fieldPlan.valueSource), Match.tagsExhaustive({
        Column: Function.constant([]),
        Transform: Function.constant([]),
        Backfill: (value) => [value.intent],
        Nullable: Function.constant([]),
        Blocked: Function.constant([]),
      }))

      const usedTransforms = Array.flatMap(fieldPlans, transformsForFieldPlan)
      const usedBackfills = Array.flatMap(fieldPlans, backfillsForFieldPlan)

      const copies = (fieldPlan: FieldPlan): ReadonlyArray<SqliteColumnSource | SqliteColumnValue | SqliteColumnExpression> => {
        const sourceCopy = (value: ColumnFieldSource) => {
          const copy = SqliteColumnSource.make({
            column: fieldPlan.target.name,
            source: value.field.name,
          })

          return [freeze(copy)]
        }

        const transformCopy = (value: TransformFieldSource) => {
          const copy = SqliteColumnExpression.make({
            column: fieldPlan.target.name,
            expression: value.intent.expression,
          })

          return [freeze(copy)]
        }

        const backfillCopy = (value: BackfillFieldSource) => {
          const copy = SqliteColumnValue.make({
            column: fieldPlan.target.name,
            value: value.intent.value,
          })

          return [freeze(copy)]
        }

        return pipe(
          Match.value(fieldPlan.valueSource),
          Match.tagsExhaustive({
            Column: sourceCopy,
            Transform: transformCopy,
            Backfill: backfillCopy,
            Nullable: Function.constant([]),
            Blocked: Function.constant([]),
          }),
        )
      }

      const directSteps = (fieldPlan: FieldPlan): ReadonlyArray<SqliteMigrationStep> => {
        const columnSteps = (value: ColumnFieldSource) => {
          const namesMatch = Equivalence.strictEqual<string>()(value.field.name, fieldPlan.target.name)

          if (namesMatch) {
            return []
          }

          const rename = SqliteRenameColumn.make({
            table: target.name,
            from: value.field.name,
            to: fieldPlan.target.name,
          })

          return [freeze(rename)]
        }

        const nullableSteps = () => {
          const addition = SqliteAddColumn.make({ table: target.name, column: fieldPlan.target })
          return [freeze(addition)]
        }

        return pipe(
          Match.value(fieldPlan.valueSource),
          Match.tagsExhaustive({
            Column: columnSteps,
            Transform: Function.constant([]),
            Backfill: Function.constant([]),
            Nullable: nullableSteps,
            Blocked: Function.constant([]),
          }),
        )
      }

      const rebuildSteps = () => {
        const rebuiltCopies = Array.flatMap(fieldPlans, copies)
        const rebuildTable = SqliteRebuildTable.make({ table: target, copies: rebuiltCopies })
        return [freeze(rebuildTable)]
      }

      const steps = rebuild
        ? rebuildSteps()
        : Array.flatMap(fieldPlans, directSteps)

      const identifiersMatch = Equivalence.strictEqual<string>()(source.identifier, target.identifier)

      const identifierErrors = identifiersMatch
        ? []
        : [`table ${target.name} changes its identifier`]

      const fieldPlanErrors = Array.flatMap(fieldPlans, Struct.get("errors"))
      const errors = [...identifierErrors, ...fieldPlanErrors, ...retainedErrors]

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
  const inputRelationErrors = snapshotRelationErrors(options.from)
  const outputRelationErrors = snapshotRelationErrors(options.to)
  const renameDuplicateErrors = Array.map(duplicateRenameKeys, renameDuplicateError)
  const backfillDuplicateErrors = Array.map(duplicateBackfillKeys, backfillDuplicateError)
  const transformDuplicateErrors = Array.map(duplicateTransformKeys, transformDuplicateError)
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
  const tableErrors = Array.flatMap(tablePlans, Struct.get("errors"))

  const errors = [
    ...inputIdentifierErrors,
    ...outputIdentifierErrors,
    ...inputRelationErrors,
    ...outputRelationErrors,
    ...renameDuplicateErrors,
    ...backfillDuplicateErrors,
    ...transformDuplicateErrors,
    ...idErrors,
    ...invalidTransformErrors,
    ...droppedTableErrors,
    ...unusedRenameErrors,
    ...unusedBackfillErrors,
    ...unusedTransformErrors,
    ...tableErrors,
  ]

  const migrationSteps = Array.flatMap(tablePlans, Struct.get("steps"))

  const recreatedTableNames = (step: SqliteMigrationStep) =>
    pipe(
      Match.value(step),
      Match.tagsExhaustive({
        SqliteCreateTable: (create) => [create.table.name],
        SqliteRebuildTable: (rebuild) => [rebuild.table.name],
        SqliteAddColumn: Function.constant([]),
        SqliteRenameColumn: Function.constant([]),
        SqliteCreateIndex: Function.constant([]),
        SqliteDropIndex: Function.constant([]),
        SqliteBlockedChange: Function.constant([]),
      }),
    )

  const recreatedTableNamesFlat = Array.flatMap(migrationSteps, recreatedTableNames)
  const recreatedTables = HashSet.fromIterable(recreatedTableNamesFlat)

  const declaredIndexEntries = (table: TableSnapshot): ReadonlyArray<SqliteCreateIndex> => {
    const indexes = declaredIndexes(table)

    const tableIndexEntry = (index: DeclaredIndex) => SqliteCreateIndex.make({
      table: table.name,
      name: index.name,
      fields: index.fields,
    })

    return Array.map(indexes, tableIndexEntry)
  }

  const allDeclaredIndexEntries = (tables: ReadonlyArray<TableSnapshot>) =>
    Array.flatMap(tables, declaredIndexEntries)

  const keyedDeclaredIndexEntry = (entry: SqliteCreateIndex) => [entry.name, entry] as const
  const sourceIndexes = allDeclaredIndexEntries(options.from.tables)
  const targetIndexes = allDeclaredIndexEntries(options.to.tables)
  const sourceIndexEntries = Array.map(sourceIndexes, keyedDeclaredIndexEntry)
  const targetIndexEntries = Array.map(targetIndexes, keyedDeclaredIndexEntry)
  const sourceIndexesByName = HashMap.fromIterable(sourceIndexEntries)
  const targetIndexesByName = HashMap.fromIterable(targetIndexEntries)

  const matchingIndex = (source: SqliteCreateIndex, target: SqliteCreateIndex) => {
    const tableMatches = Equivalence.strictEqual<string>()(source.table, target.table)
    const definitionMatches = sameIndexDescription(source, target)
    const definitionsMatch = tableMatches && definitionMatches
    const tableWasRecreated = HashSet.has(recreatedTables, source.table)
    const retainedTable = !tableWasRecreated
    return definitionsMatch && retainedTable
  }

  const targetIndexMatches = (source: SqliteCreateIndex) => (target: SqliteCreateIndex) =>
    matchingIndex(source, target)

  const sourceIndexMatches = (target: SqliteCreateIndex) => (source: SqliteCreateIndex) =>
    matchingIndex(source, target)

  const dropForSourceIndex = (source: SqliteCreateIndex) => {
    const matchingTarget = pipe(
      HashMap.get(targetIndexesByName, source.name),
      Option.exists(targetIndexMatches(source)),
    )

    if (matchingTarget) {
      return []
    }

    const drop = SqliteDropIndex.make({ name: source.name })
    return [freeze(drop)]
  }

  const createForTargetIndex = (target: SqliteCreateIndex) => {
    const matchingSource = pipe(
      HashMap.get(sourceIndexesByName, target.name),
      Option.exists(sourceIndexMatches(target)),
    )

    return matchingSource ? [] : [freeze(target)]
  }

  const drops = Array.flatMap(sourceIndexes, dropForSourceIndex)
  const creates = Array.flatMap(targetIndexes, createForTargetIndex)
  const blockedSteps = Array.map(errors, blocked)
  const steps = [...drops, ...migrationSteps, ...creates, ...blockedSteps]

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
  const rename = pipe(Flag.string("rename"), Flag.mapEffect(parseSqliteRename), Flag.atLeast(0))
  const backfill = pipe(Flag.string("backfill"), Flag.mapEffect(parseSqliteBackfill), Flag.atLeast(0))
  const transformFlag = Flag.string("transform")
  const transformDescription = "table:column:SQL-expression; the expression reads physical --from columns before renames"
  const transformWithDescription = Flag.withDescription(transformFlag, transformDescription)
  const transform = pipe(transformWithDescription, Flag.mapEffect(parseSqliteTransform), Flag.atLeast(0))

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

  const planCommand = Effect.fn("SqliteMigrations.planCommand")(function* (
    { from, id, rename, backfill, transform, out },
  ) {
    const initialSnapshot = emptySnapshot()
    const initialSnapshotEffect = Effect.succeed(initialSnapshot)
    const noPrevious = Function.constant(initialSnapshotEffect)

    const previous = yield* Option.match(from, {
      onNone: noPrevious,
      onSome: readPrevious,
    })

    const target = snapshotFromTable(options.tables)

    const planningConfig = SqliteMigrationPlanningConfig.make({
      id,
      from: previous,
      to: target,
      renames: rename,
      backfills: backfill,
      transforms: transform,
    })

    const artifact = planSqliteMigration(planningConfig)
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
    return yield* pipe(
      readMigrationManifest(manifest),
      Effect.mapError((cause) => CliError.UserError.make({
        cause,
        userMessage: "Could not load the registered SQLite migration manifest",
      })),
    )
  })

  const generateCommand = Effect.fn("SqliteMigrations.generateCommand")(function* (
    input: Readonly<{
      name: string
      rename: ReadonlyArray<SqliteRename>
      backfill: ReadonlyArray<SqliteBackfill>
      transform: ReadonlyArray<SqliteTransform>
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

    const target = snapshotFromTable(options.tables)

    const planningConfig = SqliteMigrationPlanningConfig.make({
      id,
      from: previous,
      to: target,
      renames: rename,
      backfills: backfill,
      transforms: transform,
    })

    const artifact = planSqliteMigration(planningConfig)
    const hasBlockedChange = Array.some(artifact.steps, Schema.is(SqliteBlockedChange))

    if (hasBlockedChange) {
      return yield* CliError.UserError.make({
        cause: artifact,
        userMessage: unresolvedMessage(artifact),
      })
    }

    const nextHistory = Array.append(loaded.migrations, artifact)

    yield* pipe(
      validateHistory(nextHistory),
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
  load: Effect.fn("SqliteMigrations.load")(function* (manifest: string) {
    const loadedManifest = yield* readMigrationManifest(manifest)
    return loadedManifest.migrations
  }),
  command: sqliteMigrationsCommand,
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
        onSome: migrationTo,
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
      const expectedCurrent = hasEmptyLedger ? emptySnapshot() : Option.match(previousMigration, { onNone: emptySnapshot, onSome: migrationTo })
      yield* verifyDatabase(sql, expectedCurrent)

      const pendingMigrations = Array.drop(migrations, ledger.length)
      const applyPendingMigration = (migration: SqliteMigration, index: number) => applyMigration(sql, migration, index + ledger.length)

      yield* Effect.forEach(pendingMigrations, applyPendingMigration, { discard: true })
      return yield* verifyDatabase(sql, target)
    }),
  })
