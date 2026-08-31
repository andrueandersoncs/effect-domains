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
import { Domain, PersistedRef, Query, Table } from "../index.ts"
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

const incrementUserScore = (user: User): User =>
  UserSchema.make({
    ...user,
    score: user.score + 1,
  })

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

const ArticleSchema = Schema.Struct({
  name: Schema.String,
  rating: Schema.Number,
})

/** Use Article because generated-row tests need the decoded source value type. */
interface Article extends Schema.Schema.Type<typeof ArticleSchema> {}

const Articles = Table.make(ArticleSchema, { name: "articles" })

const CreateArticle = Query.make(Articles, {
  Request: ArticleSchema,
  Result: Articles.rowSchema,
  implementation: Effect.fn("CreateArticle.implementation")(function* (article) {
    const db = yield* Database

    const rows = yield* db<Readonly<Record<string, unknown>>>`
      INSERT INTO ${db(Articles.name)} ${db.insert(article)}
      RETURNING *
    `

    return pipe(rows, Array.get(0), Option.getOrUndefined)
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

const createArticleWithGeneratedIdentifier = Effect.fn(
  "SqliteBun.createArticleWithGeneratedIdentifier",
)(function* (adapter: ReturnType<typeof layer>) {
  const result = yield* pipe(
    Effect.gen(function* () {
      yield* Articles.createTable()
      return yield* CreateArticle.execute({ name: "Declarative Data", rating: 5 })
    }),
    Effect.provide(adapter),
  )

  return result
})

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

const runPersistedRefContract = (adapter: ReturnType<typeof layer>) =>
  pipe(
    Effect.gen(function* () {
      yield* Users.createTable()

      const id = UserIdSchema.make("persisted-ref-user")

      const original = UserSchema.make({
        id,
        displayName: "Grace Hopper",
        secret: "compiler",
        score: 0,
      })

      yield* CreateUser.execute(original)

      const loadUser = Effect.fn("PersistedRefTest.loadUser")(function* () {
        const found = yield* FindUser.execute(id)

        if (Option.isNone(found)) {
          return yield* Effect.fail({
            _tag: "PersistedUserNotFound" as const,
            id,
          })
        }

        return found.value
      })

      const commitUser = Effect.fn("PersistedRefTest.commitUser")(function* (
        _previous: User,
        next: User,
      ) {
        const updated = yield* UpdateUser.execute(next)

        if (Option.isNone(updated)) {
          return yield* Effect.fail({
            _tag: "PersistedUserNotFound" as const,
            id,
          })
        }

        return updated.value
      })

      const load = loadUser()
      const userRef = yield* PersistedRef.make(commitUser)(load)
      const update = userRef.update(incrementUserScore)
      const updates = Array.replicate(update, 10)

      yield* Effect.all(updates, { concurrency: "unbounded" })

      const cached = yield* userRef.get
      const stored = yield* FindUser.execute(id)
      const storedUser = Option.getOrThrow(stored)

      expect(cached.score).toBe(10)
      expect(storedUser).toEqual(cached)
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

const expectGeneratedArticle = (
  article: Schema.Schema.Type<typeof Articles.rowSchema>,
) => {
  expect(article.name).toBe("Declarative Data")
  expect(article.rating).toBe(5)
  expect(article.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(Articles.identifier).toBe("id")
  expect(Articles.identifierSchema).toBe(Articles.rowSchema.fields.id)

  const firstField = pipe(Articles.fields, Array.get(0), Option.getOrThrow)
  const generation = Option.getOrThrow(firstField.generation)

  expect(generation).toBe("uuidv7")

  return article
}

describe("Bun SQLite tables and queries", () => {
  test("creates a derived table and runs authored CRUD queries", () =>
    pipe(
      withTemporaryDatabase(runCrudContract),
      Effect.runPromise,
    ))

  test("backs a shared persisted reference with authored queries", () =>
    pipe(
      withTemporaryDatabase(runPersistedRefContract),
      Effect.runPromise,
    ))

  test("adds and generates a UUIDv7 identifier when the schema has none", () =>
    pipe(
      withTemporaryDatabase(createArticleWithGeneratedIdentifier),
      Effect.runPromise,
    ).then(expectGeneratedArticle))

  test("uses an explicit domain identifier instead of the UUIDv7 default", () => {
    expect(Users.identifier).toBe("id")
    expect(Users.identifierSchema).toBe(UserIdSchema)
    expect(Users.rowSchema).toBe(UserSchema)

    const firstField = pipe(Users.fields, Array.get(0), Option.getOrThrow)
    const hasGeneration = Option.isSome(firstField.generation)

    expect(hasGeneration).toBeFalse()
  })

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
