import { Array, Effect, flow, Function, HashMap, HashSet, Match, Option, pipe, Record, Schema, Struct } from "effect"
import { SqlClient, Statement } from "effect/unstable/sql"
import { quoteIdentifier, renderColumn, renderCreateIndexes, renderCreateTable, renderIndex } from "./sqlite-ddl.ts"

import {
  LedgerTable,
  type SqliteMigration,
  SqliteAddColumn,
  SqliteColumnCopySchema,
  SqliteColumnExpression,
  SqliteColumnSource,
  SqliteColumnValue,
  SqliteCreateIndex,
  SqliteCreateTable,
  SqliteDropIndex,
  type SqliteMigrationStep,
  SqliteRebuildTable,
  SqliteRenameColumn,
  type SqliteSchemaSnapshot,
  asMigrationFailure,
  canonicalText,
  copiedColumns,
  declaredIndexes,
  migrationFailure,
  snapshotTable,
} from "./sqlite-migration-model.ts"

import { TableSnapshot } from "./table.ts"

const same = <A>(self: A, that: A) => self === that

// Tokenize because SQL literal whitespace is semantically significant.
const normalizedSql = (sql: string) => {
  const trimmed = sql.trim()
  const withoutTerminator = trimmed.replace(/;$/, "")
  const tokens = withoutTerminator.match(
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
  query,
  Effect.asVoid,
  Effect.mapError(asMigrationFailure("SQLite schema operation failed")),
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
      const index = Option.getOrThrow(Array.findFirst(indexes, (candidate) => candidate.name === create.name))

      return [statement(sql)(renderIndex(create.table)(index))]
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

export {
  applyMigration,
  applyStatement,
  SqliteMigrationRowsSchema,
  verifyDatabase,
}
