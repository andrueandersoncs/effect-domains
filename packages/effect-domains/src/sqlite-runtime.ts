import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Array, Config, Context, DateTime, Effect, Equivalence, FileSystem, Function, HashMap, Layer, Option, Predicate, Record, Ref, Schema, Struct, pipe } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"

import {
  RepositoryError,
  RepositoryStore,
  UniqueViolation,
  type RepositoryAccess,
} from "./repository-store.ts"

import { PolicySql } from "./policy-sql.ts"
import { Policy, PolicyEnvironment } from "./policy.ts"
import { SchemaStore } from "./migrations.ts"
import { makeMigrationStore, type SqliteMigration } from "./sqlite-migrations.ts"
import type { Table } from "./table.ts"
import { SqliteList } from "./sqlite-list.ts"
import { Value } from "./value.ts"

class InsertReturnedNoRow extends Schema.TaggedError<InsertReturnedNoRow>()(
  "InsertReturnedNoRow",
  {},
) {}

class PrivateDatabaseConflict extends Schema.TaggedError<PrivateDatabaseConflict>()(
  "PrivateDatabaseConflict",
  { application: Schema.String, execution: Schema.String },
) {}

const repositoryFailure = (resource: string) => (cause: unknown) =>
  RepositoryError.make({ resource, cause })

const unknownEquals = Equivalence.strictEqual<unknown>()
const emptyGuard = Record.empty<string, unknown>()

const absentPolicyValue = Option.none<Readonly<Record<string, unknown>>>()

const whereFragment = (sql: SqlClient.SqlClient) => ([field, value]: readonly [string, unknown]) =>
  unknownEquals(value, null) ? sql`${sql(field)} IS NULL` : sql`${sql(field)} = ${value}`




const constraintColumn = (column: string) => {
  const segments = column.trim().split(".")
  const last = Array.get(segments, segments.length - 1)
  return Option.getOrThrow(last)
}

const transactionFailure = (cause: SqlError.SqlError) =>
  pipe(cause, repositoryFailure("transaction"), Effect.fail)

const constraintColumns = (value: string) => {
  const columns = value.split(",")
  return Array.map(columns, constraintColumn)
}

const errorMessage = (value: unknown) => {
  if (value instanceof Error) return Option.some(value.message)
  if (!Predicate.isObject(value)) return Option.none<string>()

  const hasMessage = "message" in value
  if (!hasMessage) return Option.none<string>()

  return pipe(
    Option.fromNullishOr((value as Readonly<Record<string, unknown>>).message),
    Option.filter(Predicate.isString),
  )
}

const isUniqueViolation = (
  reason: SqlError.SqlError["reason"],
): reason is Extract<SqlError.SqlError["reason"], { readonly _tag: "UniqueViolation" }> =>
  Equivalence.strictEqual<typeof reason._tag>()(reason._tag, "UniqueViolation")

const capturedConstraint = (match: RegExpExecArray) =>
  Array.get(match, 1)

const uniqueConstraint = (table: Table, cause: SqlError.SqlError) => {
  const message = pipe(errorMessage(cause.reason.cause), Option.getOrElse(Function.constant(cause.message)))
  const uniqueReason = isUniqueViolation(cause.reason)

  const source = uniqueReason
    ? Option.some(cause.reason.constraint)
    : pipe(
      /(?:UNIQUE|PRIMARY KEY) constraint failed:\s*(.+)$/i.exec(message),
      Option.fromNullishOr,
      Option.flatMap(capturedConstraint),
    )

  const primaryKey = /PRIMARY KEY constraint failed/i.test(message)
  const foundSource = Option.isSome(source)
  const knownUnique = uniqueReason || foundSource
  const unique = knownUnique || primaryKey
  if (!unique) return Option.none<UniqueViolation>()

  const sourceValue = pipe(source, Option.getOrElse(Function.constant("unknown")))
  const unknownSource = Equivalence.strictEqual<string>()(sourceValue, "unknown")
  const primaryFields = primaryKey ? [table.identifier] : []
  const fields = unknownSource ? primaryFields : constraintColumns(sourceValue)
  const relationEntries = table.relations?.unique ?? []

  const matchesFields = (entry: typeof relationEntries[number]) => {
    const sameSize = Equivalence.strictEqual<number>()(entry.fields.length, fields.length)
    const containsField = (field: string) => Array.contains(fields, field)
    const sameFields = Array.every(entry.fields, containsField)
    return sameSize && sameFields
  }

  const declared = Array.findFirst(relationEntries, matchesFields)
  const fieldCount = Array.length(fields)
  const oneField = Equivalence.strictEqual<number>()(fieldCount, 1)
  const fieldMatchesIdentifier = pipe(Array.get(fields, 0), Option.exists((field) => unknownEquals(field, table.identifier)))
  const identifier = oneField && fieldMatchesIdentifier
  const fallback = identifier || primaryKey ? table.identifier : Array.join(fields, ", ")
  const constraint = pipe(declared, Option.map(Struct.get("name")), Option.getOrElse(Function.constant(fallback)))
  const violation = UniqueViolation.make({ resource: table.name, constraint, fields })

  return Option.some(violation)
}

const persistenceFailure = (table: Table) => (
  cause: SqlError.SqlError,
): Effect.Effect<never, RepositoryError | UniqueViolation> => pipe(
  uniqueConstraint(table, cause),
  Option.match({
    onNone: () => pipe(cause, repositoryFailure(table.name), Effect.fail),
    onSome: Effect.fail,
  }),
)


const makeRepositoryStore = Effect.fn("RepositoryStore.make")(function* (sqlClient: SqlClient.SqlClient) {
  const policyBinders = yield* pipe(HashMap.empty<Policy, ReturnType<typeof PolicySql.compile>>(), Ref.make)

  const registerPolicy = (policy: Policy) => (registry: HashMap.HashMap<Policy, ReturnType<typeof PolicySql.compile>>) => {
    const cached = HashMap.get(registry, policy)
    if (Option.isSome(cached)) return [cached.value, registry] as const
    const compiled = PolicySql.compile(policy)
    const updated = HashMap.set(registry, policy, compiled)
    return [compiled, updated] as const
  }

  const policyBinding = Effect.fn("RepositoryStore.policyBinding")(
    function* (table: Table, access: RepositoryAccess) {
      const recover = Function.flow(repositoryFailure(table.name), Effect.fail)

      const binder = yield* pipe(
        Ref.modify(policyBinders, registerPolicy(access.policy)),
        Effect.catchDefect(recover),
      )

      const environment = new PolicyEnvironment({
        subject: access.subject,
        row: absentPolicyValue,
        next: absentPolicyValue,
      })

      return yield* pipe(binder(sqlClient, environment), Effect.mapError(repositoryFailure(table.name)))
    },
  )

  return RepositoryStore.of({
    select: Effect.fn("RepositoryStore.select")(function* (table, query, access) {
      const policy = yield* policyBinding(table, access)
      const rendered = SqliteList.render(sqlClient, sqlClient, query, [policy])

      return yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          SELECT * FROM ${sqlClient(table.name)}
          WHERE ${rendered.where}
          ORDER BY ${rendered.order}
          LIMIT ${query.limit}
        `,
        Effect.mapError(repositoryFailure(table.name)),
      )
    }),
    insert: Effect.fn("RepositoryStore.insert")(function* (table, value) {
      const rows = yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          INSERT INTO ${sqlClient(table.name)} ${sqlClient.insert(value as Record<string, unknown>)}
          RETURNING *
        `,
        Effect.catchIf(SqlError.isSqlError, persistenceFailure(table)),
      )

      const row = Array.get(rows, 0)

      if (Option.isNone(row)) {
        return yield* RepositoryError.make({
          resource: table.name,
          cause: InsertReturnedNoRow.make({}),
        })
      }

      return row.value
    }),
    update: Effect.fn("RepositoryStore.update")(function* (table, value, access, guard = emptyGuard) {
      const key = value[table.identifier]
      const policy = yield* policyBinding(table, access)
      const guardEntries = Record.toEntries(guard)
      const guards = Array.map(guardEntries, whereFragment(sqlClient))
      const conditions = [policy, sqlClient`${sqlClient(table.identifier)} = ${key}`, ...guards]

      const rows = yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          UPDATE ${sqlClient(table.name)}
          SET ${sqlClient.update(value as Record<string, unknown>, [table.identifier])}
          WHERE ${sqlClient.and(conditions)}
          RETURNING *
        `,
        Effect.catchIf(SqlError.isSqlError, persistenceFailure(table)),
      )

      return pipe(rows, Array.get(0))
    }),
    remove: Effect.fn("RepositoryStore.remove")(function* (table, key, access) {
      const policy = yield* policyBinding(table, access)

      const rows = yield* pipe(
        sqlClient<Readonly<Record<string, unknown>>>`
          DELETE FROM ${sqlClient(table.name)}
          WHERE ${policy} AND ${sqlClient(table.identifier)} = ${key}
          RETURNING ${sqlClient(table.identifier)}
        `,
        Effect.mapError(repositoryFailure(table.name)),
      )

      return Array.isReadonlyArrayNonEmpty(rows)
    }),
    transaction: Effect.fn("RepositoryStore.transaction")(function* (effect) {
      return yield* pipe(
        sqlClient.withTransaction(effect),
        Effect.catchIf(SqlError.isSqlError, transactionFailure),
      )
    }),
  })
})

const byteAt = (bytes: ReadonlyArray<number>, index: number) => pipe(
  Array.get(bytes, index),
  Option.getOrThrow,
)

const hexadecimalByte = (byte: number) => byte.toString(16).padStart(2, "0")

const uuidV7 = () => {
  const randomBytes = new Uint8Array(10)
  const bytes = crypto.getRandomValues(randomBytes)
  const values = Array.fromIterable(bytes)
  const timestamp = Date.now().toString(16).padStart(12, "0")
  const timestampHigh = timestamp.substring(0, 8)
  const timestampLow = timestamp.substring(8, 12)
  const firstByte = byteAt(values, 0)
  const randomAHigh = firstByte & 0x0f
  const randomAByte = byteAt(values, 1)
  const randomALow = hexadecimalByte(randomAByte)
  const variantSource = byteAt(values, 2)
  const variantByte = (variantSource & 0x3f) | 0x80
  const variant = hexadecimalByte(variantByte)
  const fourthByte = byteAt(values, 3)
  const fourth = hexadecimalByte(fourthByte)
  const randomBBytes = Array.drop(values, 3)
  const randomB = pipe(randomBBytes, Array.map(hexadecimalByte), Array.join(""))

  return `${timestampHigh}-${timestampLow}-7${randomAHigh.toString(16)}${randomALow}-${variant}${fourth}-${randomB.substring(2)}`
}

const runtimeValues = Value.of({
  uuidV7: () => Effect.sync(uuidV7),
  now: () => DateTime.now,
})

const values = Layer.succeed(Value, runtimeValues)

const migrationStore = (
  options: Readonly<{ migrations: ReadonlyArray<SqliteMigration> }>,
) => (sql: SqlClient.SqlClient) => makeMigrationStore(sql, options.migrations)

const enableForeignKeys = (context: Context.Context<SqlClient.SqlClient>) => {
  const sql = Context.get(context, SqlClient.SqlClient)

  return pipe(
    sql`PRAGMA foreign_keys = ON`,
    Effect.asVoid,
  )
}

const stringEquals = Equivalence.strictEqual<string>()
const relativeParents = HashMap.make([".", true], ["", true])

const ensureParentDirectory = (filename: string) =>
  Effect.sync(() => {
    const memory = stringEquals(filename, ":memory:")
    if (memory) return

    const directory = dirname(filename)
    const relative = HashMap.has(relativeParents, directory)
    if (relative) return

    mkdirSync(directory, { recursive: true })
  })

const DatabaseFileSchema = Schema.Struct({ name: Schema.String, file: Schema.String })
const DatabaseFilesSchema = Schema.Array(DatabaseFileSchema)

const mainDatabaseFile = Effect.fn("SqliteRuntime.mainDatabaseFile")(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql`PRAGMA database_list`
  const databases = yield* Schema.decodeUnknownEffect(DatabaseFilesSchema)(rows)
  const main = Array.findFirst(databases, ({ name }) => stringEquals(name, "main"))

  return pipe(
    main,
    Option.map(({ file }) => file),
    Option.getOrThrow,
  )
})

const assertDistinctDatabases = Effect.fn("SqliteRuntime.assertDistinctDatabases")(function* (
  application: SqlClient.SqlClient,
  execution: SqlClient.SqlClient,
) {
  const applicationFile = yield* mainDatabaseFile(application)
  const executionFile = yield* mainDatabaseFile(execution)
  const hasApplicationFile = !Equivalence.strictEqual<string>()(applicationFile, "")
  const hasExecutionFile = !Equivalence.strictEqual<string>()(executionFile, "")
  const filesOnDisk = hasApplicationFile && hasExecutionFile
  if (!filesOnDisk) return

  const fs = yield* FileSystem.FileSystem
  const applicationStats = fs.stat(applicationFile)
  const executionStats = fs.stat(executionFile)
  const [left, right] = yield* Effect.all([applicationStats, executionStats])

  const sameInode = pipe(
    left.ino,
    Option.zipWith(right.ino, unknownEquals),
    Option.getOrElse(Function.constant(false)),
  )

  const sameDevice = unknownEquals(left.dev, right.dev)
  const sameLocation = sameDevice && sameInode
  const sameName = stringEquals(applicationFile, executionFile)
  const sameFile = sameName || sameLocation

  if (sameFile) {
    return yield* pipe(
      PrivateDatabaseConflict.make({ application: applicationFile, execution: executionFile }),
      Effect.fail,
    )
  }
})

export const environmentPrefix = (name: string) => name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")

const privateDatabaseEnvironment = (application: string) => (purpose: string) =>
  `${environmentPrefix(application)}_${environmentPrefix(purpose)}_DB`

const privateDatabaseConfig = (application: string) => (purpose: string) =>
  pipe(
    privateDatabaseEnvironment(application)(purpose),
    Config.string,
    Config.withDefault(`data/${application}-${purpose}.sqlite`),
  )

const privateDatabaseFilename = (
  application: string,
  purpose: string,
  configured: Option.Option<string>,
) => {
  const defaultFilename = privateDatabaseConfig(application)(purpose)

  return Option.match(configured, {
    onSome: Effect.succeed,
    onNone: Function.constant(defaultFilename),
  })
}

type SqliteClientLayer = (filename: string) => Layer.Layer<SqlClient.SqlClient>

const privateClient = (clientLayer: SqliteClientLayer) => (
  options: Readonly<{ application: string; purpose: string }> & Readonly<Partial<{ filename: string }>>,
) => pipe(
  Effect.gen(function* () {
    const application = yield* SqlClient.SqlClient
    const configured = Option.fromNullishOr(options.filename)
    const filename = yield* privateDatabaseFilename(options.application, options.purpose, configured)
    yield* ensureParentDirectory(filename)

    const verifyDatabase = (context: Context.Context<SqlClient.SqlClient>) => {
      const execution = Context.get(context, SqlClient.SqlClient)
      return assertDistinctDatabases(application, execution)
    }

    return pipe(
      clientLayer(filename),
      Layer.tap(verifyDatabase),
    )
  }),
  Layer.unwrap,
)

const sqlClient = (clientLayer: SqliteClientLayer) => (
  filename: string,
  options: Readonly<{ migrations: ReadonlyArray<SqliteMigration> }>,
) => pipe(
  ensureParentDirectory(filename),
  Effect.map(() => {
    const repositoryStore = Effect.flatMap(SqlClient.SqlClient, makeRepositoryStore)
    const migrationStoreEffect = Effect.map(SqlClient.SqlClient, migrationStore(options))
    const repositoryLayer = Layer.effect(RepositoryStore, repositoryStore)
    const schemaStoreLayer = Layer.effect(SchemaStore, migrationStoreEffect)
    const stores = Layer.mergeAll(repositoryLayer, schemaStoreLayer, values)

    const database = pipe(
      clientLayer(filename),
      Layer.tap(enableForeignKeys),
    )

    return Layer.provideMerge(stores, database)
  }),
  Layer.unwrap,
)

export const makeSqliteRuntime = (clientLayer: SqliteClientLayer) => ({
  privateClient: privateClient(clientLayer),
  sqlClient: sqlClient(clientLayer),
  values,
})
