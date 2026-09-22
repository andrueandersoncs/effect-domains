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
import { sqliteMigrationStore, type SqliteMigration } from "./sqlite-migrations.ts"
import type { Table } from "./table.ts"
import { SqliteList } from "./sqlite-list.ts"
import { Value } from "./value.ts"
import type { StructValue } from "./domain.ts"



class PrivateDatabaseConflict extends Schema.TaggedError<PrivateDatabaseConflict>()(
  "PrivateDatabaseConflict",
  { application: Schema.String, execution: Schema.String },
) {}

const makeRepositoryError = (resource: string) => RepositoryError.make({ resource })
const repositoryFailure = Function.flow(makeRepositoryError, Effect.fail)

const unknownEquals = Equivalence.strictEqual<unknown>()
const emptyGuard = Record.empty<string, unknown>()

const absentPolicyValue = Option.none<StructValue>()

const whereFragment = (sql: SqlClient.SqlClient) => ([field, value]: readonly [string, unknown]) =>
  unknownEquals(value, null) ? sql`${sql(field)} IS NULL` : sql`${sql(field)} = ${value}`





const transactionFailure = () =>
  repositoryFailure("transaction")


const errorMessage = (value: unknown) => {
  if (value instanceof Error) return Option.some(value.message)
  if (!Predicate.isObject(value)) return Option.none<string>()

  const hasMessage = "message" in value

  if (!hasMessage) return Option.none<string>()

  return pipe(
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    Option.fromNullishOr((value as StructValue).message),
    Option.filter(Predicate.isString),
  )
}

const isUniqueViolation = (
  reason: SqlError.SqlError["reason"],
): reason is Extract<SqlError.SqlError["reason"], { readonly _tag: "UniqueViolation" }> =>
  Equivalence.strictEqual<typeof reason._tag>()(reason._tag, "UniqueViolation")


const uniqueConstraint = (table: Table, cause: SqlError.SqlError) => {
  const message = pipe(errorMessage(cause.reason.cause), Option.getOrElse(Function.constant(cause.message)))
  const uniqueReason = isUniqueViolation(cause.reason)
  const sqliteUnique = /(?:UNIQUE|PRIMARY KEY) constraint failed:/i.test(message)
  const recognizedUniqueViolation = uniqueReason || sqliteUnique
  const unsupportedViolation = !recognizedUniqueViolation

  if (unsupportedViolation) return Option.none<UniqueViolation>()

  const violation = UniqueViolation.make({ resource: table.name })

  return Option.some(violation)
}

const persistenceFailure = (table: Table) => (
  cause: SqlError.SqlError,
): Effect.Effect<never, RepositoryError | UniqueViolation> => pipe(
  uniqueConstraint(table, cause),
  Option.match({
    onNone: () => repositoryFailure(table.name),
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
      const recover = () => repositoryFailure(table.name)

      const binder = yield* pipe(
        Ref.modify(policyBinders, registerPolicy(access.policy)),
        Effect.catchDefect(recover),
      )

      const environment = new PolicyEnvironment({
        subject: access.subject,
        row: absentPolicyValue,
        next: absentPolicyValue,
      })

      return yield* pipe(binder(sqlClient, environment), Effect.catch(recover))
    },
  )

  return RepositoryStore.of({
    select: Effect.fn("RepositoryStore.select")(function* (table, query, access) {
      const policy = yield* policyBinding(table, access)
      const rendered = SqliteList.render(sqlClient, sqlClient, query, [policy])

      return yield* pipe(
        sqlClient<StructValue>`
          SELECT * FROM ${sqlClient(table.name)}
          WHERE ${rendered.where}
          ORDER BY ${rendered.order}
          LIMIT ${query.limit}
        `,
        Effect.catch(() => repositoryFailure(table.name)),
      )
    }),
    insert: Effect.fn("RepositoryStore.insert")(function* (table, value) {
      // SAFETY: Repository insert values are StructValue because the repository contract accepts schema-derived object rows.
      const rows = yield* pipe(
        sqlClient<StructValue>`
          INSERT INTO ${sqlClient(table.name)} ${sqlClient.insert(value as StructValue)}
          RETURNING *
        `,
        Effect.catchIf(SqlError.isSqlError, persistenceFailure(table)),
      )

      const row = Array.get(rows, 0)

      if (Option.isNone(row)) {
        return yield* repositoryFailure(table.name)
      }

      return row.value
    }),
    update: Effect.fn("RepositoryStore.update")(function* (table, value, access, guard = emptyGuard) {
      const key = value[table.identifier]
      const policy = yield* policyBinding(table, access)
      const guardEntries = Record.toEntries(guard)
      const guards = Array.map(guardEntries, whereFragment(sqlClient))
      const conditions = [policy, sqlClient`${sqlClient(table.identifier)} = ${key}`, ...guards]

      // SAFETY: Repository update values are StructValue because the repository contract accepts schema-derived object rows.
      const rows = yield* pipe(
        sqlClient<StructValue>`
          UPDATE ${sqlClient(table.name)}
          SET ${sqlClient.update(value as StructValue, [table.identifier])}
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
        sqlClient<StructValue>`
          DELETE FROM ${sqlClient(table.name)}
          WHERE ${policy} AND ${sqlClient(table.identifier)} = ${key}
          RETURNING ${sqlClient(table.identifier)}
        `,
        Effect.catch(() => repositoryFailure(table.name)),
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
) => (sql: SqlClient.SqlClient) => sqliteMigrationStore(sql, options.migrations)

const enableForeignKeys = (context: Context.Context<SqlClient.SqlClient>) => {
  const sql = Context.get(context, SqlClient.SqlClient)

  return pipe(
    sql`PRAGMA foreign_keys = ON`,
    Effect.asVoid,
  )
}


const relativeParents = HashMap.make([".", true], ["", true])

const ensureParentDirectory = (filename: string) =>
  Effect.sync(() => {
    const memory = Equivalence.strictEqual<string>()(filename, ":memory:")

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
  const main = Array.findFirst(databases, ({ name }) => Equivalence.strictEqual<string>()(name, "main"))

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
  const sameName = Equivalence.strictEqual<string>()(applicationFile, executionFile)
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

type SqliteClientLayer = (filename: string) => Layer.Layer<SqlClient.SqlClient, never, never>

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

export const sqliteRuntime = (clientLayer: SqliteClientLayer) => ({
  privateClient: privateClient(clientLayer),
  sqlClient: sqlClient(clientLayer),
  values,
})
