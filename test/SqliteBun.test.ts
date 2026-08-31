import { describe, expect, test } from "bun:test"
import { mkdtempDisposableSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Array,
  Context,
  Effect,
  flow,
  Layer,
  Option,
  pipe,
  Schema,
  SchemaGetter,
  Struct,
} from "effect"
import { Domain, Query, Table } from "../index.ts"
import { Database, layer, SqliteBunOptions } from "../src/SqliteBun.ts"
import { adapterContract } from "./adapterContract.ts"

class CodecPrefix extends Context.Service<CodecPrefix, {
  readonly prefix: string
}>()("test/CodecPrefix") {}

const decodeStoredString = SchemaGetter.transformOrFail<
  string,
  string,
  CodecPrefix
>(Effect.fn("StoredString.decode")(function* (value) {
  const { prefix } = yield* CodecPrefix
  return value.slice(prefix.length)
}))

const encodeStoredString = SchemaGetter.transformOrFail<
  string,
  string,
  CodecPrefix
>(Effect.fn("StoredString.encode")(function* (value) {
  const { prefix } = yield* CodecPrefix
  return `${prefix}${value}`
}))

const StoredStringSchema = pipe(
  Schema.String,
  Schema.decodeTo(Schema.String, {
    decode: decodeStoredString,
    encode: encodeStoredString,
  }),
)

const UserIdSchema = pipe(
  Schema.String,
  Schema.brand("UserId"),
  Domain.identifier,
)

const UserSchema = Schema.Struct({
  id: UserIdSchema,
  displayName: Schema.String,
  secret: StoredStringSchema,
  score: Schema.Number,
})

/** Use User because decoded test rows need the schema's canonical type. */
interface User extends Schema.Schema.Type<typeof UserSchema> {}

const Users = Table.make(UserSchema, { name: "users" })
const OptionalUserSchema = Schema.OptionFromNullOr(UserSchema)

const CreateUser = Query.make(Users, {
  Request: UserSchema,
  Result: UserSchema,
  implementation: Effect.fn("CreateUser.implementation")(function* (user) {
    const db = yield* Database
    const insert = db.insert(user)

    const rows = yield* db<Readonly<Record<string, unknown>>>`
      INSERT INTO ${db(Users.name)} ${insert}
      RETURNING *
    `

    const firstRow = pipe(rows, Array.get(0), Option.getOrUndefined)

    return firstRow
  }),
})

const FindUser = Query.make(Users, {
  Request: UserIdSchema,
  Result: OptionalUserSchema,
  implementation: Effect.fn("FindUser.implementation")(function* (id) {
    const db = yield* Database

    const rows = yield* db<Readonly<Record<string, unknown>>>`
      SELECT * FROM ${db(Users.name)}
      WHERE ${db(Users.identifier)} = ${id}
      LIMIT 1
    `

    const firstRow = pipe(rows, Array.get(0), Option.getOrNull)

    return firstRow
  }),
})

const UpdateUser = Query.make(Users, {
  Request: UserSchema,
  Result: OptionalUserSchema,
  implementation: Effect.fn("UpdateUser.implementation")(function* (user) {
    const db = yield* Database
    const identifier = user[Users.identifier]
    const changes = db.update(user, [Users.identifier])

    const rows = yield* db<Readonly<Record<string, unknown>>>`
      UPDATE ${db(Users.name)}
      SET ${changes}
      WHERE ${db(Users.identifier)} = ${identifier}
      RETURNING *
    `

    const firstRow = pipe(rows, Array.get(0), Option.getOrNull)

    return firstRow
  }),
})

const DeleteUser = Query.make(Users, {
  Request: UserIdSchema,
  Result: Schema.Boolean,
  implementation: Effect.fn("DeleteUser.implementation")(function* (id) {
    const db = yield* Database

    const rows = yield* db<Readonly<Record<string, unknown>>>`
      DELETE FROM ${db(Users.name)}
      WHERE ${db(Users.identifier)} = ${id}
      RETURNING ${db(Users.identifier)}
    `

    return rows.length > 0
  }),
})

const PrefixLive = Layer.succeed(CodecPrefix, { prefix: "stored:" })

const toDatabaseDirectoryPrefix = (directory: string) =>
  join(directory, "effect-domains-")

const makeDatabaseDirectory = Effect.sync(
  flow(tmpdir, toDatabaseDirectoryPrefix, mkdtempDisposableSync),
)

const removeDatabaseDirectory = Effect.fn("Database.removeDirectory")(
  function* (directory: ReturnType<typeof mkdtempDisposableSync>) {
    directory.remove()
  },
)

const withTemporaryDatabase = <A, E, R>(
  use: (adapter: ReturnType<typeof layer>) => Effect.Effect<A, E, R>,
) =>
  pipe(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        makeDatabaseDirectory,
        removeDatabaseDirectory,
      )

      const filename = join(directory.path, "test.sqlite")
      const options = new SqliteBunOptions(filename)
      const adapter = layer(options)

      return yield* use(adapter)
    }),
    Effect.scoped,
  )

const runCrudContract = (adapter: ReturnType<typeof layer>) =>
  pipe(
    Effect.gen(function* () {
      yield* Users.createTable()

      const id = UserIdSchema.make("user-1")
      const missingId = UserIdSchema.make("missing")

      const original = UserSchema.make({
        id,
        displayName: "Ada",
        secret: "analytical-engine",
        score: 1,
      })

      const replacement = UserSchema.make({
        id,
        displayName: "Ada Lovelace",
        secret: "difference-engine",
        score: 2,
      })

      const missingReplacement = UserSchema.make({
        ...replacement,
        id: missingId,
      })

      yield* adapterContract({
        keyOf: Struct.get("id"),
        original,
        replacement,
        missingReplacement,
        missingKey: missingId,
        create: CreateUser,
        read: FindUser,
        update: UpdateUser,
        delete: DeleteUser,
      })
    }),
    Effect.provide(adapter),
    Effect.provide(PrefixLive),
  )

const FirstUsers = Table.make(UserSchema, { name: "first_users" })
const SecondUsers = Table.make(UserSchema, { name: "second_users" })

const createMultipleTables = Effect.fn("SqliteBun.createMultipleTables")(function* (
  adapter: ReturnType<typeof layer>,
) {
  const createFirstTable = FirstUsers.createTable()
  const createSecondTable = SecondUsers.createTable()
  const createTables = Effect.all([createFirstTable, createSecondTable])

  return yield* pipe(createTables, Effect.provide(adapter))
})

const expectTablesCreated = (created: ReadonlyArray<void>) => {
  const expectation = expect(created)
  expectation.toEqual([undefined, undefined])

  return created
}

describe("Bun SQLite tables and queries", () => {
  test("creates a derived table and runs authored CRUD queries", () =>
    pipe(
      withTemporaryDatabase(runCrudContract),
      Effect.runPromise,
    ))

  test("keeps database and codec services as execution requirements", () => {
    const queryRequiresDatabase = true satisfies (
      Context.Service.Identifier<typeof Database> extends Effect.Services<
        ReturnType<typeof CreateUser.execute>
      > ? true : false
    )

    const queryRequiresCodec = true satisfies (
      Context.Service.Identifier<typeof CodecPrefix> extends Effect.Services<
        ReturnType<typeof CreateUser.execute>
      > ? true : false
    )

    expect(queryRequiresDatabase).toBeTrue()
    expect(queryRequiresCodec).toBeTrue()
    expect(CreateUser.table).toBe(Users)
    expect(FindUser.Request).toBe(UserIdSchema)
    expect(FindUser.Result).toBe(OptionalUserSchema)
  })

  test("supports multiple table definitions through one runtime layer", () =>
    pipe(
      withTemporaryDatabase(createMultipleTables),
      Effect.runPromise,
    ).then(expectTablesCreated))
})
