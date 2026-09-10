import { Array, Effect, Equivalence, FileSystem, flow, Function, HashMap, HashSet, Match, Option, Order, pipe, Predicate, Record, Result, Schema, Stdio, Stream, Struct, Tuple } from "effect"
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

const SqliteRenameIntentsSchema = Schema.Array(SqliteRename)
const SqliteBackfillIntentsSchema = Schema.Array(SqliteBackfill)
const SqliteTransformIntentsSchema = Schema.Array(SqliteTransform)
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
const prettyJson = (value: unknown) => JSON.stringify(value, null, 2)
const jsonText = flow(canonical, prettyJson, (value) => `${value}\n`)
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

const blocked = flow((reason: string) => SqliteBlockedChange.make({ reason }), freeze)

const normalizedFieldEquals = (left: TableField, right: TableField) => {
  const leftMetadata = fieldMetadata(left)
  const rightMetadata = fieldMetadata(right)
  return fieldMetadataEquals(leftMetadata, rightMetadata)
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

    return migration
  },
)

const SqliteSnapshotJsonSchema = Schema.toCodecJson(SqliteSchemaSnapshot)

const snapshotRelationErrors = (snapshot: SqliteSchemaSnapshot) => {
  const relationValidation = Table.validateRelations(snapshot.tables)
  const resultEffect = Effect.result(relationValidation)
  const result = Effect.runSync(resultEffect)

  return Result.match(result, {
    onFailure: flow(relationFailure, Struct.get("reason"), Array.of),
    onSuccess: Function.constant([] as ReadonlyArray<string>),
  })
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

  if (Predicate.isTagged(step, "SqliteBlockedChange")) {
    return yield* migrationFailure(step.reason)
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

const parseColumnIntent = (input: string) => {
  const first = input.indexOf(":")
  const second = input.indexOf(":", first + 1)
  const invalid = first <= 0 || second <= first + 1
  if (invalid) return Option.none<readonly [string, string, string]>()
  const parts = [input.slice(0, first), input.slice(first + 1, second), input.slice(second + 1)] as const
  return Option.some(parts)
}

const parseSqliteBackfill = (input: string) => {
  const parts = parseColumnIntent(input)

  if (Option.isNone(parts)) {
    return pipe(invalidIntent("--backfill", input, "table:column:JSON-value"), Effect.fail)
  }

  const [table, column, valueSource] = parts.value

  return pipe(
    Schema.decodeUnknownEffect(MigrationValueSourceSchema)(valueSource),
    Effect.mapError(() => invalidIntent("--backfill", input, "table:column:JSON-value")),
    Effect.map((value) => pipe(SqliteBackfill.make({ table, column, value }), freeze)),
  )
}

const parseSqliteTransform = (input: string) => {
  const parts = pipe(
    parseColumnIntent(input),
    Option.filter(([, , expression]) => sqlExpressionIsValid(expression)),
  )

  if (Option.isNone(parts)) {
    return pipe(invalidIntent("--transform", input, "table:column:SQL-expression"), Effect.fail)
  }

  const [table, column, expression] = parts.value
  return pipe(SqliteTransform.make({ table, column, expression }), freeze, Effect.succeed)
}

const writeJson = Effect.fn("SqliteMigrations.writeJson")(function* (
  value: unknown,
  out: Option.Option<string>,
) {
  const output = jsonText(value)

  if (Option.isSome(out)) {
    const fileSystem = yield* FileSystem.FileSystem
    return yield* fileSystem.writeFileString(out.value, output)
  }

  const stdio = yield* Stdio.Stdio
  const stdout = stdio.stdout()
  return yield* pipe(Stream.make(output), Stream.run(stdout))
})

const PlannerErrorsSchema = Schema.Array(Schema.String)
const OptionalTableFieldSchema = Schema.Option(TableField)
const OptionalSqliteRenameSchema = Schema.Option(SqliteRename)
const OptionalSqliteColumnCopySchema = Schema.Option(SqliteColumnCopySchema)

class ColumnReconciliation extends Schema.Class<ColumnReconciliation>(
  "ColumnReconciliation",
)({
  source: OptionalTableFieldSchema,
  rename: OptionalSqliteRenameSchema,
  copy: OptionalSqliteColumnCopySchema,
  direct: SqliteMigrationStepsSchema,
  errors: PlannerErrorsSchema,
  consumed: PlannerErrorsSchema,
}) {}

class TableReconciliation extends Schema.Class<TableReconciliation>(
  "TableReconciliation",
)({
  steps: SqliteMigrationStepsSchema,
  errors: PlannerErrorsSchema,
  consumed: PlannerErrorsSchema,
  recreates: Schema.Boolean,
}) {}

const EmptyPlannerErrors: ReadonlyArray<string> = []
const EmptyMigrationSteps: ReadonlyArray<SqliteMigrationStep> = []
const sameString = Equivalence.strictEqual<string>()
const tableMap = flow(Array.map(migrationTableEntry), HashMap.fromIterable)

const intentKey = (kind: string, table: string, column: string) => `${kind}\u0000${table}\u0000${column}`
const renameIntentKey = (intent: SqliteRename) => intentKey("rename", intent.table, intent.to)
const backfillIntentKey = (intent: SqliteBackfill) => intentKey("backfill", intent.table, intent.column)
const transformIntentKey = (intent: SqliteTransform) => intentKey("transform", intent.table, intent.column)

const duplicateIntentError = (kind: string, key: string) => {
  const [, table, column] = key.split("\u0000")
  return `duplicate ${kind} intent for ${table}.${column}`
}

const recordIntent = <A>(kind: string, key: (value: A) => string) =>
  (
    [valuesByKey, errors]: readonly [HashMap.HashMap<string, A>, ReadonlyArray<string>],
    value: A,
  ) => {
    const valueKey = key(value)
    const duplicate = HashMap.has(valuesByKey, valueKey)
    const duplicateErrors = duplicate ? [duplicateIntentError(kind, valueKey)] : EmptyPlannerErrors
    const nextErrors = Array.appendAll(errors, duplicateErrors)

    return [HashMap.set(valuesByKey, valueKey, value), nextErrors] as const
  }

const recordIntents = <A>(
  kind: string,
  values: ReadonlyArray<A>,
  key: (value: A) => string,
) => {
  const valuesByKey = HashMap.empty<string, A>()
  const initial = [valuesByKey, EmptyPlannerErrors] as const
  return Array.reduce(values, initial, recordIntent(kind, key))
}

const changedRename = (rename: SqliteRename) => !sameString(rename.from, rename.to)

const renameDestinationIn = (sources: HashSet.HashSet<string>) => (rename: SqliteRename) =>
  HashSet.has(sources, rename.to)

const requiresRenameRebuild = (renames: ReadonlyArray<SqliteRename>) => {
  const changed = Array.filter(renames, changedRename)
  const sources = pipe(changed, Array.map(Struct.get("from")), HashSet.fromIterable)
  return Array.some(changed, renameDestinationIn(sources))
}

const planningRenames = (value: SqliteMigrationPlanningConfig["renames"]) =>
  pipe(Option.fromNullishOr(value), Option.getOrElse(Function.constant([] as ReadonlyArray<SqliteRename>)))

const planningBackfills = (value: SqliteMigrationPlanningConfig["backfills"]) =>
  pipe(Option.fromNullishOr(value), Option.getOrElse(Function.constant([] as ReadonlyArray<SqliteBackfill>)))

const planningTransforms = (value: SqliteMigrationPlanningConfig["transforms"]) =>
  pipe(Option.fromNullishOr(value), Option.getOrElse(Function.constant([] as ReadonlyArray<SqliteTransform>)))

const intentFor = <A>(
  valid: boolean,
  valuesByKey: HashMap.HashMap<string, A>,
  key: string,
) =>
  valid ? HashMap.get(valuesByKey, key) : Option.none<A>()

const plannerErrors = (condition: boolean, message: string) =>
  condition ? [message] : EmptyPlannerErrors

const intentErrors = <A>(
  valid: boolean,
  intent: Option.Option<A>,
  message: string,
) => {
  const invalid = !valid
  return Option.isSome(intent) ? plannerErrors(invalid, message) : EmptyPlannerErrors
}

const consumedIntent = <A>(
  valid: boolean,
  intent: Option.Option<A>,
  key: (value: A) => string,
) =>
  valid
    ? pipe(
      intent,
      Option.match({
        onNone: Function.constant(EmptyPlannerErrors),
        onSome: flow(key, Array.of),
      }),
    )
    : EmptyPlannerErrors

const expressionCopy = (field: TableField) => (transform: SqliteTransform) => pipe(
  SqliteColumnExpression.make({ column: field.name, expression: transform.expression }),
  freeze,
)

const sourceCopy = (field: TableField) => (source: TableField) => pipe(
  SqliteColumnSource.make({ column: field.name, source: source.name }),
  freeze,
)

const fieldMetadataChanges = (target: TableField) => (source: TableField) =>
  !normalizedFieldEquals(source, target)

const backfillCopy = (field: TableField) => (backfill: SqliteBackfill) => pipe(
  SqliteColumnValue.make({ column: field.name, value: backfill.value }),
  freeze,
)

const directColumnSteps = (table: string, target: TableField, source: Option.Option<TableField>) =>
  pipe(
    source,
    Option.match({
      onNone: () => {
        const step = SqliteAddColumn.make({ table, column: target })
        return [freeze(step)]
      },
      onSome: (field) => {
        if (sameString(field.name, target.name)) return EmptyMigrationSteps

        const step = SqliteRenameColumn.make({ table, from: field.name, to: target.name })
        return [freeze(step)]
      },
    }),
  )

const reconcileColumn = (
  table: string,
  sources: HashMap.HashMap<string, TableField>,
  renames: HashMap.HashMap<string, SqliteRename>,
  backfills: HashMap.HashMap<string, SqliteBackfill>,
  transforms: HashMap.HashMap<string, SqliteTransform>,
) =>
  (target: TableField) => {
    const renameKey = intentKey("rename", table, target.name)
    const rename = HashMap.get(renames, renameKey)

    const sourceName = pipe(
      rename,
      Option.match({
        onNone: Function.constant(target.name),
        onSome: Struct.get("from"),
      }),
    )

    const source = HashMap.get(sources, sourceName)
    const sourcePresent = Option.isSome(source)

    const validRename = pipe(
      rename,
      Option.match({
        onNone: Function.constant(true),
        onSome: Function.constant(sourcePresent),
      }),
    )

    const transformKey = intentKey("transform", table, target.name)
    const transform = intentFor(validRename, transforms, transformKey)
    const validTransform = Option.exists(transform, flow(Struct.get("expression"), sqlExpressionIsValid))
    const backfillKey = intentKey("backfill", table, target.name)
    const backfill = intentFor(validRename, backfills, backfillKey)
    const sourceMissing = Option.isNone(source)
    const hasBackfill = Option.isSome(backfill)
    const usesBackfill = Array.every([sourceMissing, !validTransform, hasBackfill], Boolean)
    const metadataChanged = Option.exists(source, fieldMetadataChanges(target))

    const missingRequiredValue = Array.every(
      [sourceMissing, !target.nullable, !validTransform, !hasBackfill],
      Boolean,
    )

    const renameErrors = intentErrors(
      validRename,
      rename,
      `rename source ${table}.${sourceName} does not exist`,
    )

    const metadataWithoutTransform = Array.every([metadataChanged, !validTransform], Boolean)

    const metadataErrors = plannerErrors(
      metadataWithoutTransform,
      `field ${table}.${target.name} changes storage metadata without a transform`,
    )

    const requiredValueErrors = plannerErrors(
      missingRequiredValue,
      `field ${table}.${target.name} requires an explicit backfill or transform`,
    )

    const errors = pipe(
      renameErrors,
      Array.appendAll(metadataErrors),
      Array.appendAll(requiredValueErrors),
    )

    const emptyCopy = Option.none<Schema.Schema.Type<typeof SqliteColumnCopySchema>>()

    const transformed = validTransform
      ? pipe(transform, Option.map(expressionCopy(target)))
      : emptyCopy

    const copiedSource = pipe(source, Option.map(sourceCopy(target)))

    const copiedValue = usesBackfill
      ? pipe(backfill, Option.map(backfillCopy(target)))
      : emptyCopy

    const preferredCopy = pipe(
      transformed,
      Option.orElse(Function.constant(copiedSource)),
      Option.orElse(Function.constant(copiedValue)),
    )

    const errorFree = Array.isReadonlyArrayEmpty(errors)
    const copy = errorFree ? preferredCopy : emptyCopy
    const hasErrors = !errorFree
    const preventsDirectChange = Array.some([hasErrors, validTransform, usesBackfill], Boolean)

    const direct = preventsDirectChange
      ? EmptyMigrationSteps
      : directColumnSteps(table, target, source)

    const renameConsumed = consumedIntent(validRename, rename, renameIntentKey)
    const transformConsumed = consumedIntent(validTransform, transform, transformIntentKey)
    const backfillConsumed = consumedIntent(usesBackfill, backfill, backfillIntentKey)

    const consumed = pipe(
      renameConsumed,
      Array.appendAll(transformConsumed),
      Array.appendAll(backfillConsumed),
    )

    return ColumnReconciliation.make({ source, rename, copy, direct, errors, consumed })
  }

const retainedSourceNames = flow(
  Array.map(Struct.get<ColumnReconciliation, "source">("source")),
  Array.getSomes,
  Array.map(Struct.get("name")),
  HashSet.fromIterable,
)

const droppedSourceError = (table: string, retained: HashSet.HashSet<string>) =>
  (field: TableField) =>
    HashSet.has(retained, field.name)
      ? EmptyPlannerErrors
      : [`field ${table}.${field.name} would be dropped or renamed without intent`]

const copyRequiresValueRebuild = (copy: Schema.Schema.Type<typeof SqliteColumnCopySchema>) =>
  !Predicate.isTagged(copy, "SqliteColumnSource")

const columnRequiresValueRebuild = flow(
  Struct.get<ColumnReconciliation, "copy">("copy"),
  Option.exists(copyRequiresValueRebuild),
)

const newTableReconciliation = (table: TableSnapshot) => {
  const step = SqliteCreateTable.make({ table })
  const steps = [freeze(step)]

  return TableReconciliation.make({
    steps,
    errors: EmptyPlannerErrors,
    consumed: EmptyPlannerErrors,
    recreates: true,
  })
}

const existingTableReconciliation = (
  target: TableSnapshot,
  renames: HashMap.HashMap<string, SqliteRename>,
  backfills: HashMap.HashMap<string, SqliteBackfill>,
  transforms: HashMap.HashMap<string, SqliteTransform>,
) =>
  (source: TableSnapshot) => {
    const sourceFields = fieldMap(source)
    const reconcile = reconcileColumn(target.name, sourceFields, renames, backfills, transforms)
    const columns = Array.map(target.fields, reconcile)
    const retained = retainedSourceNames(columns)
    const retainedErrors = pipe(source.fields, Array.flatMap(droppedSourceError(target.name, retained)))

    const usedRenames = pipe(
      columns,
      Array.map(Struct.get<ColumnReconciliation, "rename">("rename")),
      Array.getSomes,
    )

    const requiresValueRebuild = Array.some(columns, columnRequiresValueRebuild)
    const renameRebuild = requiresRenameRebuild(usedRenames)
    const constraintsChanged = !constraintsEqual(source, target)

    const recreates = Array.some(
      [requiresValueRebuild, renameRebuild, constraintsChanged],
      Boolean,
    )

    const copies = pipe(
      columns,
      Array.map(Struct.get<ColumnReconciliation, "copy">("copy")),
      Array.getSomes,
    )

    const steps = recreates
      ? pipe(SqliteRebuildTable.make({ table: target, copies }), freeze, Array.of)
      : pipe(columns, Array.flatMap(Struct.get("direct")))

    const identifierChanged = !sameString(source.identifier, target.identifier)

    const identifierErrors = plannerErrors(
      identifierChanged,
      `table ${target.name} changes its identifier`,
    )

    const columnErrors = pipe(columns, Array.flatMap(Struct.get("errors")))

    const errors = pipe(
      identifierErrors,
      Array.appendAll(columnErrors),
      Array.appendAll(retainedErrors),
    )

    const consumed = pipe(columns, Array.flatMap(Struct.get("consumed")))

    return TableReconciliation.make({ steps, errors, consumed, recreates })
  }

const tableReconciliation = (
  sources: HashMap.HashMap<string, TableSnapshot>,
  renames: HashMap.HashMap<string, SqliteRename>,
  backfills: HashMap.HashMap<string, SqliteBackfill>,
  transforms: HashMap.HashMap<string, SqliteTransform>,
) =>
  (target: TableSnapshot) => {
    const source = HashMap.get(sources, target.name)

    if (Option.isNone(source)) {
      return newTableReconciliation(target)
    }

    const reconcileExistingTable = existingTableReconciliation(
      target,
      renames,
      backfills,
      transforms,
    )

    return reconcileExistingTable(source.value)
  }

const invalidTransformErrors = (transform: SqliteTransform) =>
  sqlExpressionIsValid(transform.expression)
    ? EmptyPlannerErrors
    : [`transform ${transform.table}.${transform.column} must be one SQL expression without comments or semicolons`]

const unusedRenameMessage = (rename: SqliteRename) =>
  `unused rename intent for ${rename.table}.${rename.from}`

const unusedBackfillMessage = (backfill: SqliteBackfill) =>
  `unused backfill intent for ${backfill.table}.${backfill.column}`

const unusedTransformMessage = (transform: SqliteTransform) =>
  `unused transform intent for ${transform.table}.${transform.column}`

const unusedIntentErrors = <A>(
  consumed: HashSet.HashSet<string>,
  key: (value: A) => string,
  message: (value: A) => string,
) =>
  (intent: A) => {
    const intentKeyForValue = key(intent)
    return HashSet.has(consumed, intentKeyForValue) ? EmptyPlannerErrors : [message(intent)]
  }

const droppedTableErrors = (targets: HashMap.HashMap<string, TableSnapshot>) =>
  (table: TableSnapshot) =>
    HashMap.has(targets, table.name)
      ? EmptyPlannerErrors
      : [`table ${table.name} would be dropped`]

const createIndexStep = (table: TableSnapshot) => (index: DeclaredIndex) => pipe(
  SqliteCreateIndex.make({ table: table.name, name: index.name, fields: index.fields }),
  freeze,
)

const declaredIndexSteps = (table: TableSnapshot) =>
  pipe(declaredIndexes(table), Array.map(createIndexStep(table)))

const sameIndexStep = (
  recreated: HashSet.HashSet<string>,
  source: SqliteCreateIndex,
  target: SqliteCreateIndex,
) => {
  const sameTable = sameString(source.table, target.table)
  const sameDescription = sameIndexDescription(source, target)
  const sourceRecreated = HashSet.has(recreated, source.table)
  return Array.every([sameTable, sameDescription, !sourceRecreated], Boolean)
}

const matchingIndex = (
  recreated: HashSet.HashSet<string>,
  source: SqliteCreateIndex,
) =>
  (target: SqliteCreateIndex) =>
    sameIndexStep(recreated, source, target)

const matchingSourceIndex = (
  recreated: HashSet.HashSet<string>,
  target: SqliteCreateIndex,
) =>
  (source: SqliteCreateIndex) =>
    sameIndexStep(recreated, source, target)

const dropChangedIndex = (
  targets: HashMap.HashMap<string, SqliteCreateIndex>,
  recreated: HashSet.HashSet<string>,
) =>
  (source: SqliteCreateIndex) => {
    const target = HashMap.get(targets, source.name)
    const matches = Option.filter(target, matchingIndex(recreated, source))

    return pipe(
      matches,
      Option.match({
        onNone: () => {
          const step = SqliteDropIndex.make({ name: source.name })
          return [freeze(step)]
        },
        onSome: Function.constant(EmptyMigrationSteps),
      }),
    )
  }

const createChangedIndex = (
  sources: HashMap.HashMap<string, SqliteCreateIndex>,
  recreated: HashSet.HashSet<string>,
) =>
  (target: SqliteCreateIndex) => {
    const source = HashMap.get(sources, target.name)
    const matches = Option.filter(source, matchingSourceIndex(recreated, target))

    return pipe(
      matches,
      Option.match({
        onNone: Function.constant([target]),
        onSome: Function.constant(EmptyMigrationSteps),
      }),
    )
  }

const tableNameForRecreatedReconciliation = (
  pair: readonly [TableSnapshot, TableReconciliation],
) => {
  const table = Tuple.get(pair, 0)
  const reconciliation = Tuple.get(pair, 1)
  return reconciliation.recreates ? [table.name] : EmptyPlannerErrors
}

const migrationIndexEntry = (index: SqliteCreateIndex) => [index.name, index] as const

const planSqliteMigration = (input: SqliteMigrationPlanningConfig) => {
  const options = SqliteMigrationPlanningConfig.make(input)
  const renames = planningRenames(options.renames)
  const backfills = planningBackfills(options.backfills)
  const transforms = planningTransforms(options.transforms)
  const fromTables = tableMap(options.from.tables)
  const toTables = tableMap(options.to.tables)
  const [renamesByKey, renameErrors] = recordIntents("rename", renames, renameIntentKey)
  const [backfillsByKey, backfillErrors] = recordIntents("backfill", backfills, backfillIntentKey)
  const [transformsByKey, transformErrors] = recordIntents("transform", transforms, transformIntentKey)
  const reconciler = tableReconciliation(fromTables, renamesByKey, backfillsByKey, transformsByKey)
  const reconciliations = Array.map(options.to.tables, reconciler)

  const consumed = pipe(
    reconciliations,
    Array.flatMap(Struct.get("consumed")),
    HashSet.fromIterable,
  )

  const idIsEmpty = Equivalence.strictEqual<number>()(options.id.length, 0)
  const migrationIdErrors = plannerErrors(idIsEmpty, "migration id must not be empty")
  const invalidTransforms = pipe(transforms, Array.flatMap(invalidTransformErrors))
  const droppedTables = pipe(options.from.tables, Array.flatMap(droppedTableErrors(toTables)))

  const unusedRenames = pipe(
    renames,
    Array.flatMap(unusedIntentErrors(consumed, renameIntentKey, unusedRenameMessage)),
  )

  const unusedBackfills = pipe(
    backfills,
    Array.flatMap(unusedIntentErrors(consumed, backfillIntentKey, unusedBackfillMessage)),
  )

  const unusedTransforms = pipe(
    transforms,
    Array.flatMap(unusedIntentErrors(consumed, transformIntentKey, unusedTransformMessage)),
  )

  const reconciliationErrors = pipe(reconciliations, Array.flatMap(Struct.get("errors")))

  const errors = [
    ...identifiers(options.from),
    ...identifiers(options.to),
    ...snapshotRelationErrors(options.from),
    ...snapshotRelationErrors(options.to),
    ...renameErrors,
    ...backfillErrors,
    ...transformErrors,
    ...migrationIdErrors,
    ...invalidTransforms,
    ...droppedTables,
    ...unusedRenames,
    ...unusedBackfills,
    ...unusedTransforms,
    ...reconciliationErrors,
  ]

  const migrationSteps = pipe(reconciliations, Array.flatMap(Struct.get("steps")))
  const tableReconciliationPairs = Array.zip(options.to.tables, reconciliations)

  const recreatedTableNames = Array.flatMap(
    tableReconciliationPairs,
    tableNameForRecreatedReconciliation,
  )

  const recreatedTables = HashSet.fromIterable(recreatedTableNames)
  const sourceIndexes = pipe(options.from.tables, Array.flatMap(declaredIndexSteps))
  const targetIndexes = pipe(options.to.tables, Array.flatMap(declaredIndexSteps))
  const targetIndexEntries = Array.map(targetIndexes, migrationIndexEntry)
  const targetIndexesByName = HashMap.fromIterable(targetIndexEntries)
  const sourceIndexEntries = Array.map(sourceIndexes, migrationIndexEntry)
  const sourceIndexesByName = HashMap.fromIterable(sourceIndexEntries)
  const drops = pipe(sourceIndexes, Array.flatMap(dropChangedIndex(targetIndexesByName, recreatedTables)))
  const creates = pipe(targetIndexes, Array.flatMap(createChangedIndex(sourceIndexesByName, recreatedTables)))
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
  const out = pipe(Flag.file("out"), Flag.optional)

  const snapshotCommand = Effect.fn("SqliteMigrations.snapshotCommand")(function* ({ out }) {
    const snapshot = snapshotFromTable(options.tables)
    const encodedSnapshot = encodeSnapshot(snapshot)
    return yield* writeJson(encodedSnapshot, out)
  })

  const snapshot = Command.make("snapshot", { out }, snapshotCommand)
  const from = pipe(Flag.file("from"), Flag.optional)
  const id = Flag.string("id")
  const rename = pipe(Flag.string("rename"), Flag.mapEffect(parseSqliteRename), Flag.atLeast(0))
  const backfill = pipe(Flag.string("backfill"), Flag.mapEffect(parseSqliteBackfill), Flag.atLeast(0))

  const transform = pipe(
    Flag.string("transform"),
    Flag.withDescription("table:column:SQL-expression; the expression reads physical --from columns before renames"),
    Flag.mapEffect(parseSqliteTransform),
    Flag.atLeast(0),
  )

  const planArtifact = (
    id: string,
    from: SqliteSchemaSnapshot,
    renames: ReadonlyArray<SqliteRename>,
    backfills: ReadonlyArray<SqliteBackfill>,
    transforms: ReadonlyArray<SqliteTransform>,
  ) =>
    pipe(SqliteMigrationPlanningConfig.make({
      id, from, to: snapshotFromTable(options.tables), renames, backfills, transforms,
    }), planSqliteMigration)

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
    const previous = yield* Option.match(from, {
      onNone: flow(emptySnapshot, Effect.succeed),
      onSome: readPrevious,
    })

    const artifact = planArtifact(id, previous, rename, backfill, transform)
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

    const artifact = planArtifact(id, previous, rename, backfill, transform)
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

    const artifactText = pipe(encodeMigration(artifact), jsonText)
    const manifestEntries = Array.append(loaded.entries, entry)
    const manifestText = jsonText({ migrations: manifestEntries })
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
