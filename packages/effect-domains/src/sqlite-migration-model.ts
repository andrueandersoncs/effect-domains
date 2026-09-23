import { Array, Effect, Equivalence, flow, Function, HashSet, Match, Option, Order, pipe, Predicate, Record, Schema, Struct } from "effect"
import { MigrationError } from "./migrations.ts"
import { Table, TableField, TableSnapshot } from "./table.ts"

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
  { table: Schema.String },
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
    table: Schema.String,
    copies: SqliteColumnCopiesSchema,
  },
) {}

class SqliteCreateIndex extends Schema.TaggedClass<SqliteCreateIndex>()(
  "SqliteCreateIndex",
  {
    table: Schema.String,
    name: Schema.String,
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
  to: SqliteSchemaSnapshot,
  steps: SqliteMigrationStepsSchema,
}) {}

const freeze = <A>(value: A): A => {
  const object = Predicate.isObjectKeyword(value)

  if (!object) return value

  const frozen = Object.isFrozen(value)

  if (frozen) return value

  const values = Record.values(value)

  Array.forEach(values, freeze)

  return Object.freeze(value)
}

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return Array.map(value, sortJson)
  if (!Predicate.isObject(value)) return value

  const entries = Record.toEntries(value)
  const sorted = Array.sortWith(entries, ([key]) => key, Order.String)
  const values = Array.map(sorted, ([key, nested]) => [key, sortJson(nested)] as const)

  return Record.fromEntries(values)
}

const canonicalText = flow(JSON.stringify, JSON.parse, sortJson, JSON.stringify)
const snapshotEquals = Schema.toEquivalence(SqliteSchemaSnapshot)

const schemaSnapshot = (tables: ReadonlyArray<TableSnapshot>) =>
  pipe(SqliteSchemaSnapshot.make({ version: SchemaVersion, tables: [...tables] }), freeze)

const emptySnapshot = schemaSnapshot([])
const snapshotFromTable = flow(Array.map(Table.snapshot), schemaSnapshot)
const declaredIndexes = (table: TableSnapshot) => table.relations?.indexes ?? []
const same = Equivalence.strictEqual<unknown>()
const uniqueCount = flow(HashSet.fromIterable<string>, HashSet.size)

const migrationFailure = (reason: string) =>
  MigrationError.make({ reason })

const asMigrationFailure = (reason: string) => (cause: unknown) =>
  Schema.is(MigrationError)(cause) ? cause : migrationFailure(reason)

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const relationFailure = flow(errorMessage, migrationFailure)

const validateSnapshot = Effect.fn("SqliteMigrations.validateSnapshot")(function* (snapshot: SqliteSchemaSnapshot) {
  const tableNames = Array.map(snapshot.tables, Struct.get("name"))
  const tableCount = uniqueCount(tableNames)

  if (!same(tableCount, tableNames.length)) return yield* migrationFailure("table names must be unique")

  yield* Effect.forEach(snapshot.tables, Effect.fn("SqliteMigrations.validateTable")(function* (table) {
    const names = Array.map(table.fields, Struct.get("name"))
    const allNames = [...names, table.name, table.identifier]

    if (Array.contains(allNames, "")) return yield* migrationFailure("table names, field names and identifiers must not be empty")

    const count = uniqueCount(names)

    if (!same(count, names.length)) return yield* migrationFailure(`table ${table.name} contains duplicate fields`)

    const isIdentifier = (field: TableField) => same(field.name, table.identifier)
    const identifier = Array.findFirst(table.fields, isIdentifier)
    const validIdentifier = Option.exists(identifier, (field) => !field.nullable)

    if (!validIdentifier) return yield* migrationFailure(`table ${table.name} must have a non-nullable identifier field ${table.identifier}`)
  }), { discard: true })

  yield* pipe(Table.validateRelations(snapshot.tables), Effect.mapError(relationFailure))

  return snapshot
})

const sqlExpressionIsValid = (expression: string) => {
  const trimmed = expression.trim()
  const content = trimmed.length > 0
  const forbidden = /\0|;|--|\/\*/.test(expression)
  const valid = !forbidden

  return content && valid
}

const namedTable = (name: string) => (table: TableSnapshot) =>
  same(table.name, name)

const snapshotTable = (snapshot: SqliteSchemaSnapshot, name: string) =>
  Array.findFirst(snapshot.tables, namedTable(name))

const tableFor = (snapshot: SqliteSchemaSnapshot, name: string, operation: string) => pipe(
  snapshotTable(snapshot, name),
  Option.match({
    onNone: () => migrationFailure(`${operation} references unknown target table ${name}`),
    onSome: Effect.succeed,
  }),
)

const copiedColumns = (copies: ReadonlyArray<Schema.Schema.Type<typeof SqliteColumnCopySchema>>) =>
  Array.map(copies, Struct.get("column"))

const validateRebuild = (previous: SqliteSchemaSnapshot, target: SqliteSchemaSnapshot) =>
  Effect.fn("SqliteMigrations.validateRebuild")(function* (rebuild: SqliteRebuildTable) {
    const table = yield* tableFor(target, rebuild.table, "rebuild")
    const columns = copiedColumns(rebuild.copies)
    const columnCount = uniqueCount(columns)

    if (!same(columnCount, columns.length)) return yield* migrationFailure(`rebuild ${rebuild.table} copies a column more than once`)

    const targetNames = Array.map(table.fields, Struct.get("name"))
    const invalidTargetColumn = (column: string) => !Array.contains(targetNames, column)
    const invalid = Array.some(columns, invalidTargetColumn)

    if (invalid) return yield* migrationFailure(`rebuild ${rebuild.table} copies an unknown target column`)

    const previousTable = snapshotTable(previous, rebuild.table)

    const priorNames = Option.match(previousTable, {
      onNone: Function.constant([]),
      onSome: flow(Struct.get("fields"), Array.map(Struct.get("name"))),
    })

    const unlisted = (column: string) => !Array.contains(columns, column)
    const unknownPrevious = (column: string) => !Array.contains(priorNames, column)
    const missingColumn = (column: string) => unlisted(column) && unknownPrevious(column)
    const missing = Array.findFirst(targetNames, missingColumn)

    if (Option.isSome(missing)) return yield* migrationFailure(`rebuild ${rebuild.table} must explicitly copy new column ${missing.value}`)
  })

const validateMigration = Effect.fn("SqliteMigrations.validateMigration")(function* (migration: SqliteMigration) {
  if (same(migration.id.length, 0)) return yield* migrationFailure("migration id must not be empty")

  yield* validateSnapshot(migration.to)

  const expressions = pipe(
    migration.steps,
    Array.filter(Schema.is(SqliteRebuildTable)),
    Array.flatMap(Struct.get("copies")),
    Array.filter(Schema.is(SqliteColumnExpression)),
  )

  const invalid = (copy: SqliteColumnExpression) => !sqlExpressionIsValid(copy.expression)

  if (Array.some(expressions, invalid)) return yield* migrationFailure("migration copy expressions must be single SQL expressions")

  return migration
})

const validateCreateIndex = (migration: SqliteMigration) =>
  Effect.fn("SqliteMigrations.validateCreateIndex")(function* (step: SqliteCreateIndex) {
    const table = yield* tableFor(migration.to, step.table, "create index")
    const indexes = declaredIndexes(table)
    const named = (index: typeof indexes[number]) => same(index.name, step.name)
    const index = Array.findFirst(indexes, named)

    if (Option.isNone(index)) {
      return yield* migrationFailure(`create index ${step.name} is not declared by target table ${step.table}`)
    }
  })

const validateStep = (previous: SqliteSchemaSnapshot, migration: SqliteMigration) =>
  Effect.fn("SqliteMigrations.validateStep")(function* (step: SqliteMigrationStep) {
    yield* Match.value(step).pipe(
      Match.tagsExhaustive({
        SqliteCreateTable: (create) => tableFor(migration.to, create.table, "create table"),
        SqliteRebuildTable: validateRebuild(previous, migration.to),
        SqliteCreateIndex: validateCreateIndex(migration),
        SqliteAddColumn: Function.constant(Effect.void),
        SqliteRenameColumn: Function.constant(Effect.void),
        SqliteDropIndex: Function.constant(Effect.void),
      }),
    )
  })

const historySnapshot = (migrations: ReadonlyArray<SqliteMigration>, index: number) => pipe(
  Array.get(migrations, index),
  Option.match({ onNone: Function.constant(emptySnapshot), onSome: Struct.get("to") }),
)

const validateHistory = Effect.fn("SqliteMigrations.validateHistory")(function* (migrations: ReadonlyArray<SqliteMigration>) {
  const ids = Array.map(migrations, Struct.get("id"))
  const count = uniqueCount(ids)

  if (!same(count, ids.length)) return yield* migrationFailure("migration ids must be unique non-empty strings")

  yield* Effect.forEach(migrations, Effect.fn("SqliteMigrations.validateHistoryEntry")(function* (migration, index) {
    const previous = historySnapshot(migrations, index - 1)

    yield* validateMigration(migration)
    yield* Effect.forEach(migration.steps, validateStep(previous, migration), { discard: true })
  }), { discard: true })

  return freeze(migrations)
})

const SqliteMigrationHistorySchema = Schema.Array(Schema.toCodecJson(SqliteMigration))

export {
  asMigrationFailure,
  canonicalText,
  copiedColumns,
  declaredIndexes,
  emptySnapshot,
  freeze,
  historySnapshot,
  LedgerTable,
  migrationFailure,
  same,
  schemaSnapshot,
  SqliteColumnCopySchema,
  snapshotEquals,
  snapshotFromTable,
  snapshotTable,
  SqliteAddColumn,
  SqliteColumnExpression,
  SqliteColumnSource,
  SqliteColumnValue,
  SqliteCreateIndex,
  SqliteCreateTable,
  SqliteDropIndex,
  type SqliteMigrationStep,
  SqliteMigrationHistorySchema,
  SqliteRebuildTable,
  SqliteRenameColumn,
  type SqliteSchemaSnapshot,
  validateHistory,
  validateMigration,
  validateSnapshot,
}
