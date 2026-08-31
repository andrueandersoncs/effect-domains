import { describe, expect, test } from "bun:test"
import { mkdtempDisposableSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Context,
  Effect,
  Layer,
  Option,
  pipe,
  Schema,
  SchemaGetter,
} from "effect"
import { Domain, Query, Table } from "../index.ts"
import { Database, layer, SqliteBunOptions } from "../src/SqliteBun.ts"
import { adapterContract } from "./adapterContract.ts"

class CodecPrefix extends Context.Service<CodecPrefix, {
  readonly prefix: string
}>()("test/CodecPrefix") {}

const StoredString = pipe(
  Schema.String,
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transformOrFail<string, string, CodecPrefix>(
      Effect.fn("StoredString.decode")(function* (value) {
        const { prefix } = yield* CodecPrefix
        return value.slice(prefix.length)
      }),
    ),
    encode: SchemaGetter.transformOrFail<string, string, CodecPrefix>(
      Effect.fn("StoredString.encode")(function* (value) {
        const { prefix } = yield* CodecPrefix
        return `${prefix}${value}`
      }),
    ),
  }),
)

const UserId = pipe(
  Schema.String,
  Schema.brand("UserId"),
  Domain.identifier,
)

const User = Schema.Struct({
  id: UserId,
  displayName: Schema.String,
  secret: StoredString,
  score: Schema.Number,
})

const Users = Table.make(User, { name: "users" })
const OptionalUser = Schema.OptionFromNullOr(User)

const CreateUser = Query.make(Users, {
  Request: User,
  Result: User,
  implementation: Effect.fn("CreateUser.implementation")(function* (user) {
    const db = yield* Database
    const insert = db.insert(user)
    const rows = yield* db<Readonly<Record<string, unknown>>>`
      INSERT INTO ${db(Users.name)} ${insert}
      RETURNING *
    `
    return rows[0]
  }),
})

const FindUser = Query.make(Users, {
  Request: UserId,
  Result: OptionalUser,
  implementation: Effect.fn("FindUser.implementation")(function* (id) {
    const db = yield* Database
    const rows = yield* db<Readonly<Record<string, unknown>>>`
      SELECT * FROM ${db(Users.name)}
      WHERE ${db(Users.identifier)} = ${id}
      LIMIT 1
    `
    return rows[0] ?? null
  }),
})

const UpdateUser = Query.make(Users, {
  Request: User,
  Result: OptionalUser,
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
    return rows[0] ?? null
  }),
})

const DeleteUser = Query.make(Users, {
  Request: UserId,
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

const makeDatabaseDirectory = Effect.sync(() => {
  const prefix = join(tmpdir(), "effect-domains-")
  return mkdtempDisposableSync(prefix)
})

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
      return yield* use(layer(new SqliteBunOptions(filename)))
    }),
    Effect.scoped,
  )

describe("Bun SQLite tables and queries", () => {
  test("creates a derived table and runs authored CRUD queries", () =>
    pipe(
      withTemporaryDatabase((adapter) =>
        pipe(
          Effect.gen(function* () {
            yield* Users.createTable()

            const decodeId = Schema.decodeUnknownSync(UserId)
            const id = decodeId("user-1")
            const missingId = decodeId("missing")
            const original = User.make({
              id,
              displayName: "Ada",
              secret: "analytical-engine",
              score: 1,
            })
            const replacement = User.make({
              id,
              displayName: "Ada Lovelace",
              secret: "difference-engine",
              score: 2,
            })
            const missingReplacement = User.make({
              ...replacement,
              id: missingId,
            })

            yield* adapterContract({
              keyOf: (user) => user.id,
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
        ),
      ),
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
    expect(FindUser.Request).toBe(UserId)
    expect(FindUser.Result).toBe(OptionalUser)
  })

  test("supports multiple table definitions through one runtime layer", () =>
    pipe(
      withTemporaryDatabase((adapter) => {
        const First = Table.make(User, { name: "first_users" })
        const Second = Table.make(User, { name: "second_users" })

        return pipe(
          Effect.all([First.createTable(), Second.createTable()]),
          Effect.provide(adapter),
        )
      }),
      Effect.runPromise,
    ).then((created) => expect(created).toEqual([undefined, undefined])))
})
