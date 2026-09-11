import { Array, Effect, Equivalence, flow, Function, HashMap, HashSet, Match, Option, Order, pipe, Predicate, Record, Schema, Struct } from "effect"
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
  const values = Record.values(value as Record.ReadonlyRecord<string, unknown>)
  Array.forEach(values, freeze)
  return Object.freeze(value)
}

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return Array.map(value, sortJson)
  if (!Predicate.isObject(value)) return value
  const entries = Record.toEntries(value as Record.ReadonlyRecord<string, unknown>)
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

const migrationFailure = (reason: string, cause: unknown = undefined) => {
  const failure = MigrationError.make({ reason })
  const optionalCause = Option.fromUndefinedOr(cause)

  return Option.match(optionalCause, {
    onNone: Function.constant(failure),
    onSome: (value) => MigrationError.make({ reason, cause: value }),
  })
}

const asMigrationFailure = (reason: string) => (cause: unknown) =>
  Schema.is(MigrationError)(cause) ? cause : migrationFailure(reason, cause)

const relationFailure = (cause: unknown) => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return migrationFailure(reason, cause)
}

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
    yield* pipe(
      Match.value(step),
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

// Tokenize because SQL literal whitespace is semantically significant.
const normalizedSql = (sql: string) => {
  const tokens = sql.trim().replace(/;$/, "").match(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[^\s]/g,
  ) ?? []

  return Array.join(tokens, "\u0000")
}

const SqliteCatalogRowSchema = Schema.Struct({
  name: Schema.String,
  tbl_name: Schema.String,
  type: Schema.Literals(["table", "index", "trigger"]),
  sql: Schema.NullOr(Schema.String),
})

interface SqliteCatalogRow extends Schema.Schema.Type<typeof SqliteCatalogRowSchema> {}
const SqliteCatalogRowsSchema = Schema.Array(SqliteCatalogRowSchema)
const SqliteColumnRowsSchema = Schema.Array(Schema.Struct({ name: Schema.String }))
const SqliteMigrationRowsSchema = Schema.Array(Schema.Struct({ id: Schema.String, artifact: Schema.String }))
const SqliteForeignKeyRowsSchema = Schema.Array(Schema.Unknown)

const verifyForeignKeys = Effect.fn("SqliteMigrations.verifyForeignKeys")(function* (sql: SqlClient.SqlClient) {
  const rows = yield* pipe(sql`PRAGMA foreign_key_check`,
    Effect.flatMap(Schema.decodeUnknownEffect(SqliteForeignKeyRowsSchema)),
    Effect.mapError(asMigrationFailure("could not validate SQLite foreign keys")))

  if (rows.length > 0) return yield* migrationFailure("SQLite foreign key validation failed")
})

const catalogKey = (object: Pick<SqliteCatalogRow, "type" | "name">) => `${object.type}:${object.name}`

const catalogEntry = (object: SqliteCatalogRow) => {
  const key = catalogKey(object)
  return [key, object] as const
}

const expectedCatalog = (table: TableSnapshot) => {
  const statement = renderCreateTable(table)
  const object = SqliteCatalogRowSchema.make({ type: "table", name: table.name, tbl_name: table.name, sql: statement })

  const catalogIndex = (index: ReturnType<typeof declaredIndexes>[number]) => {
    const statement = renderIndex(table.name)(index)
    return SqliteCatalogRowSchema.make({ type: "index", name: index.name, tbl_name: table.name, sql: statement })
  }

  const indexes = pipe(declaredIndexes(table), Array.map(catalogIndex))
  return [object, ...indexes]
}

const verifyDatabase = Effect.fn("SqliteMigrations.verifyDatabase")(function* (
  sql: SqlClient.SqlClient,
  snapshot: SqliteSchemaSnapshot,
) {
  const actual = yield* pipe(sql`SELECT name, tbl_name, type, sql FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger')
      AND tbl_name IN (SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%')
      AND name NOT LIKE 'sqlite_autoindex_%' AND tbl_name != ${LedgerTable}`,
    Effect.flatMap(Schema.decodeUnknownEffect(SqliteCatalogRowsSchema)),
    Effect.mapError(asMigrationFailure("could not inspect SQLite schema")))

  const isTable = (object: SqliteCatalogRow) => same(object.type, "table")
  const tables = Array.filter(actual, isTable)
  const expectedNames = pipe(snapshot.tables, Array.map(Struct.get("name")), HashSet.fromIterable)
  const unexpectedTable = (table: SqliteCatalogRow) => !HashSet.has(expectedNames, table.name)
  const countMatches = same(tables.length, snapshot.tables.length)
  const namesMatch = !Array.some(tables, unexpectedTable)
  const tablesMatch = countMatches && namesMatch
  if (!tablesMatch) return yield* migrationFailure("SQLite contains tables not tracked by the schema migration history")
  const catalog = pipe(actual, Array.map(catalogEntry), HashMap.fromIterable)
  const expectedObjects = Array.flatMap(snapshot.tables, expectedCatalog)
  if (!same(actual.length, expectedObjects.length)) return yield* migrationFailure("SQLite contains missing or untracked indexes or triggers")

  yield* Effect.forEach(snapshot.tables, Effect.fn("SqliteMigrations.verifyTable")(function* (table) {
    const objects = expectedCatalog(table)

    yield* Effect.forEach(objects, Effect.fn("SqliteMigrations.verifyObject")(function* (expected) {
      const key = catalogKey(expected)
      const found = HashMap.get(catalog, key)
      const drift = migrationFailure(`SQLite schema drift detected for table ${table.name}`)
      const object = yield* pipe(found, Effect.fromOption, Effect.mapError(Function.constant(drift)))
      const sqlOption = Option.fromNullishOr(object.sql)
      const objectSql = yield* pipe(sqlOption, Effect.fromOption, Effect.mapError(Function.constant(drift)))
      const actualSql = normalizedSql(objectSql)
      if (!same(object.tbl_name, table.name)) return yield* drift
      const expectedSql = pipe(Option.fromNullishOr(expected.sql), Option.getOrThrow, normalizedSql)
      if (same(actualSql, expectedSql)) return
      if (!same(expected.type, "table")) return yield* drift

      // Accept physical order because ADD COLUMN appends fields regardless of declaration order.
      const columns = yield* pipe(sql`SELECT name FROM pragma_table_info(${table.name}) ORDER BY cid`,
        Effect.flatMap(Schema.decodeUnknownEffect(SqliteColumnRowsSchema)),
        Effect.mapError(asMigrationFailure(`could not inspect columns for ${table.name}`)))

      const fields = pipe(table.fields, Array.map((field) => [field.name, field] as const), HashMap.fromIterable)
      const fieldFor = (column: Schema.Schema.Type<typeof SqliteColumnRowsSchema>[number]) => HashMap.get(fields, column.name)
      const ordered = pipe(columns, Array.map(fieldFor), Array.getSomes)
      const knownColumns = same(columns.length, ordered.length)
      const complete = same(ordered.length, table.fields.length)
      const fieldsMatch = knownColumns && complete
      if (!fieldsMatch) return yield* drift
      const physical = TableSnapshot.make({ ...table, fields: ordered })
      const physicalSql = pipe(physical, renderCreateTable, normalizedSql)
      if (!same(actualSql, physicalSql)) return yield* drift
    }), { discard: true })
  }), { discard: true })

  yield* verifyForeignKeys(sql)
})

const statement = (sql: SqlClient.SqlClient) => (text: string) => sql`${sql.literal(text)}`

const applyStatement = (query: Statement.Statement<unknown>) => pipe(
  query, Effect.asVoid, Effect.mapError(asMigrationFailure("SQLite schema operation failed")),
)

// Parameterize copy values because literals must not become executable SQL.
const compileCopy = (sql: SqlClient.SqlClient) => (copy: Schema.Schema.Type<typeof SqliteColumnCopySchema>) =>
  pipe(Match.value(copy), Match.tagsExhaustive({
    SqliteColumnSource: (source) => pipe(source.source, quoteIdentifier, sql.literal),
    SqliteColumnValue: (value) => {
      const parameter = Statement.parameter(value.value)
      return Statement.fragment([parameter])
    },
    SqliteColumnExpression: (expression) => sql.literal(expression.expression),
  }))

const quotedName = (sql: SqlClient.SqlClient) => flow(quoteIdentifier, sql.literal)

const implicitCopies = (
  previous: SqliteSchemaSnapshot,
  table: TableSnapshot,
  copies: ReadonlyArray<Schema.Schema.Type<typeof SqliteColumnCopySchema>>,
) => {
  const prior = snapshotTable(previous, table.name)

  const fieldNames = flow(
    Struct.get<TableSnapshot, "fields">("fields"),
    Array.map(Struct.get("name")),
  )

  const priorFields = Option.match(prior, { onNone: Function.constant([]), onSome: fieldNames })
  const explicitColumns = copiedColumns(copies)
  const explicit = HashSet.fromIterable(explicitColumns)
  const existing = (column: string) => Array.contains(priorFields, column)
  const notExplicit = (column: string) => !HashSet.has(explicit, column)
  const copiedByIdentity = (column: string) => existing(column) && notExplicit(column)
  const sourceCopy = (column: string) => SqliteColumnSource.make({ column, source: column })

  const identity = pipe(
    table.fields,
    Array.map(Struct.get("name")),
    Array.filter(copiedByIdentity),
    Array.map(sourceCopy),
  )

  return [...identity, ...copies]
}

const compileRebuild = (
  sql: SqlClient.SqlClient,
  previous: SqliteSchemaSnapshot,
  target: TableSnapshot,
  rebuild: SqliteRebuildTable,
) => {
  const name = quotedName(sql)
  const temporary = `__effect_schema_${rebuild.table}`
  const table = TableSnapshot.make({ ...target, name: temporary })
  const copies = implicitCopies(previous, target, rebuild.copies)
  const columns = pipe(copies, Array.map(flow(Struct.get("column"), quoteIdentifier)), sql.join(", ", false))
  const expressions = pipe(copies, Array.map(compileCopy(sql)), sql.join(", ", false))
  const create = pipe(table, renderCreateTable, statement(sql))

  return [
    create,
    sql`INSERT INTO ${name(temporary)} (${columns}) SELECT ${expressions} FROM ${name(rebuild.table)}`,
    sql`DROP TABLE ${name(rebuild.table)}`,
    sql`ALTER TABLE ${name(temporary)} RENAME TO ${name(rebuild.table)}`,
  ]
}

// Compile exhaustively because every migration instruction needs an execution meaning.
const compileStep = (
  sql: SqlClient.SqlClient,
  previous: SqliteSchemaSnapshot,
  target: SqliteSchemaSnapshot,
) => (step: SqliteMigrationStep): ReadonlyArray<Statement.Statement<unknown>> =>
  pipe(Match.value(step), Match.tagsExhaustive({
    SqliteCreateTable: (create) => {
      const tableOption = snapshotTable(target, create.table)
      const table = Option.getOrThrow(tableOption)
      return pipe(table, renderCreateTable, statement(sql), Array.of)
    },
    SqliteAddColumn: (addition) => {
      const column = renderColumn(addition.column, false)
      const name = quotedName(sql)
      return [sql`ALTER TABLE ${name(addition.table)} ADD COLUMN ${sql.literal(column)}`]
    },
    SqliteRenameColumn: (rename) => {
      const name = quotedName(sql)
      return [sql`ALTER TABLE ${name(rename.table)} RENAME COLUMN ${name(rename.from)} TO ${name(rename.to)}`]
    },
    SqliteRebuildTable: (rebuild) => {
      const tableOption = snapshotTable(target, rebuild.table)
      const table = Option.getOrThrow(tableOption)
      return compileRebuild(sql, previous, table, rebuild)
    },
    SqliteCreateIndex: (create) => {
      const tableOption = snapshotTable(target, create.table)
      const table = Option.getOrThrow(tableOption)
      const indexes = declaredIndexes(table)
      const named = (index: typeof indexes[number]) => same(index.name, create.name)
      const indexOption = Array.findFirst(indexes, named)
      const index = Option.getOrThrow(indexOption)
      return pipe(index, renderIndex(create.table), statement(sql), Array.of)
    },
    SqliteDropIndex: (drop) => {
      const name = quotedName(sql)
      return [sql`DROP INDEX ${name(drop.name)}`]
    },
  }))

const applyMigration = (
  sql: SqlClient.SqlClient,
  previous: SqliteSchemaSnapshot,
  migration: SqliteMigration,
  position: number,
) => pipe(
  Effect.gen(function* () {
    yield* sql`PRAGMA defer_foreign_keys = ON`
    const statements = Array.flatMap(migration.steps, compileStep(sql, previous, migration.to))
    yield* Effect.forEach(statements, applyStatement, { discard: true })
    yield* verifyDatabase(sql, migration.to)
    // Reset because SQLite retains its deferred-constraint counter after a parent rebuild.
    yield* sql`PRAGMA defer_foreign_keys = OFF`
    yield* sql`INSERT INTO ${sql(LedgerTable)} (position, id, artifact) VALUES (${position}, ${migration.id}, ${canonicalText(migration)})`
  }),
  sql.withTransaction,
  Effect.mapError(asMigrationFailure(`could not apply migration ${migration.id}`)),
)

const make = (input: Readonly<{
  id: string
  to: SqliteSchemaSnapshot
  steps: ReadonlyArray<SqliteMigrationStep>
}>) => pipe(SqliteMigration.make(input), validateMigration, Effect.map(freeze), Effect.runSync)

const initial = (options: Readonly<{ id: string; tables: ReadonlyArray<Table> }>) => {
  const to = snapshotFromTable(options.tables)
  const createTable = (table: TableSnapshot) => SqliteCreateTable.make({ table: table.name })
  const tables = Array.map(to.tables, createTable)

  const createIndexes = (table: TableSnapshot) => {
    const create = (index: ReturnType<typeof declaredIndexes>[number]) =>
      SqliteCreateIndex.make({ table: table.name, name: index.name })

    return pipe(declaredIndexes(table), Array.map(create))
  }

  const indexes = Array.flatMap(to.tables, createIndexes)
  return make({ id: options.id, to, steps: [...tables, ...indexes] })
}

const legacyArtifact = (artifact: unknown) =>
  Predicate.isObject(artifact) && Record.has(artifact, "from")

const decodeHistory = Effect.fn("SqliteMigrations.decodeHistory")(function* (raw: unknown) {
  const legacy = Array.isArray(raw) && Array.some(raw, legacyArtifact)
  if (legacy) return yield* migrationFailure("SQLite migration artifacts must use version 2")

  const migrations = yield* pipe(
    Schema.decodeUnknownEffect(SqliteMigrationHistorySchema)(raw),
    Effect.catch(() => Schema.decodeUnknownEffect(Schema.Array(SqliteMigration))(raw)),
    Effect.mapError(asMigrationFailure("invalid SQLite migration history")),
  )

  return yield* validateHistory(migrations)
})

const histories = (...artifacts: ReadonlyArray<unknown>) =>
  pipe(artifacts, decodeHistory, Effect.runSync)

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
  history: histories,
  decodeHistory: Effect.fn("SqliteMigrations.decodeHistory")(function* (raw: unknown) {
    return yield* decodeHistory(raw)
  }),
}

export const makeMigrationStore = (sql: SqlClient.SqlClient, migrations: ReadonlyArray<SqliteMigration>) => SchemaStore.of({
  prepare: Effect.fn("SchemaStore.prepare")(function* (tables) {
    const target = schemaSnapshot(tables)
    yield* applyStatement(sql`PRAGMA foreign_keys = ON`)
    yield* validateSnapshot(target)
    yield* validateHistory(migrations)
    const expectedTarget = historySnapshot(migrations, migrations.length - 1)
    const emptyHistory = same(migrations.length, 0)
    const missingHistory = emptyHistory && target.tables.length > 0
    if (missingHistory) return yield* migrationFailure("nonempty application schemas require an initial migration history")

    if (!snapshotEquals(expectedTarget, target)) {
      return yield* migrationFailure("the frozen migration history does not end at the application schema")
    }

    yield* applyStatement(sql`CREATE TABLE IF NOT EXISTS ${sql(LedgerTable)} (position INTEGER PRIMARY KEY NOT NULL, id TEXT UNIQUE NOT NULL, artifact TEXT NOT NULL)`)

    const ledger = yield* pipe(sql`SELECT id, artifact FROM ${sql(LedgerTable)} ORDER BY position`,
      Effect.flatMap(Schema.decodeUnknownEffect(SqliteMigrationRowsSchema)),
      Effect.mapError(asMigrationFailure("could not read SQLite migration history")))

    if (ledger.length > migrations.length) {
      return yield* migrationFailure("SQLite contains migration history not supplied by the application")
    }

    const compared = Array.zip(ledger, migrations)

    const changed = Array.findFirst(compared, ([recorded, migration]) => {
      const artifact = canonicalText(migration)
      const sameId = same(recorded.id, migration.id)
      const sameArtifact = same(recorded.artifact, artifact)
      const unchanged = sameId && sameArtifact
      return !unchanged
    })

    if (Option.isSome(changed)) {
      const [recorded] = changed.value
      return yield* migrationFailure(`migration history changed at ${recorded.id}`)
    }

    const expectedCurrent = historySnapshot(migrations, ledger.length - 1)
    yield* verifyDatabase(sql, expectedCurrent)
    const pending = Array.drop(migrations, ledger.length)

    yield* Effect.forEach(
      pending,
      Effect.fn("SchemaStore.applyPendingMigration")(function* (migration, index) {
        const previous = historySnapshot(migrations, ledger.length + index - 1)
        yield* applyMigration(sql, previous, migration, ledger.length + index)
      }),
      { discard: true },
    )

    yield* verifyDatabase(sql, target)
  }),
})
