import { describe, expect, it } from "@effect/vitest"
import { mkdtempDisposableSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Array,
  Context,
  Effect,
  Equivalence,
  flow,
  Layer,
  Option,
  pipe,
  Schema,
  SchemaGetter,
  Struct,
} from "effect"
import { identifier } from "../src/domain.ts"
import { PersistedRef } from "../src/persisted-ref.ts"
import { Query } from "../src/query.ts"
import { Database, SqliteBunRuntime } from "../src/sqlite-bun.ts"
import { Table } from "../src/table.ts"
import { adapterContract } from "./adapter-contract/effects.ts"

describe("Bun SQLite tables and queries", () => {
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
    identifier,
  )

  const UserSchema = Schema.Struct({
    id: UserIdSchema,
    displayName: Schema.String,
    secret: StoredStringSchema,
    score: Schema.Number,
  })

  interface User extends Schema.Schema.Type<typeof UserSchema> {}

  const incrementUserScore = (user: typeof UserSchema.Type) =>
    UserSchema.make({
      ...user,
      score: user.score + 1,
    })

  const Users = Table.make({ name: "users", schema: UserSchema })
  const OptionalUserSchema = Schema.OptionFromNullOr(UserSchema)

  const CreateUser = Query.make({
    table: Users,
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

  const FindUser = Query.make({
    table: Users,
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

  const UpdateUser = Query.make({
    table: Users,
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

  const DeleteUser = Query.make({
    table: Users,
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

  const numberEquivalence = Equivalence.strictEqual<number>()
  const excludeNegativeZero = (value: number) => !numberEquivalence(value, -0)
  const sqliteFiniteFilter = Schema.makeFilter(excludeNegativeZero)
  const SqliteFiniteSchema = Schema.Finite.check(sqliteFiniteFilter)

  const ArticleSchema = Schema.Struct({
    name: Schema.String,
    rating: SqliteFiniteSchema,
  })

  interface Article extends Schema.Schema.Type<typeof ArticleSchema> {}
  const Articles = Table.make({ name: "articles", schema: ArticleSchema })

  const CreateArticle = Query.make({
    table: Articles,
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

  const withTemporaryDatabase = Effect.fn("SqliteBun.withTemporaryDatabase")(
    function* <A, E, R>(
      use: (adapter: ReturnType<typeof SqliteBunRuntime.sqlClient>) => Effect.Effect<A, E, R>,
    ) {
      const directory = yield* Effect.acquireRelease(
        makeDatabaseDirectory,
        removeDatabaseDirectory,
      )

      const filename = join(directory.path, "test.sqlite")
      const adapter = SqliteBunRuntime.sqlClient(filename)

      return yield* use(adapter)
    },
  )

  const insertedArticle = (article: typeof ArticleSchema.Type) =>
    Effect.fn("SqliteBun.insertedArticle")(function* (
      adapter: ReturnType<typeof SqliteBunRuntime.sqlClient>,
    ) {
      return yield* pipe(
        Effect.gen(function* () {
          yield* Articles.write()
          return yield* CreateArticle.execute(article)
        }),
        Effect.provide(adapter),
      )
    })

  const runCrudContract = (adapter: ReturnType<typeof SqliteBunRuntime.sqlClient>) =>
    pipe(
      Effect.gen(function* () {
        yield* Users.write()

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

  const runPersistedRefContract = (adapter: ReturnType<typeof SqliteBunRuntime.sqlClient>) =>
    pipe(
      Effect.gen(function* () {
        yield* Users.write()

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
          _previous: typeof UserSchema.Type,
          next: typeof UserSchema.Type,
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
        const userRef = yield* PersistedRef.make({ commit: commitUser, load })
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

  const FirstUsers = Table.make({ name: "first_users", schema: UserSchema })
  const SecondUsers = Table.make({ name: "second_users", schema: UserSchema })

  const createMultipleTables = Effect.fn("SqliteBun.createMultipleTables")(function* (
    adapter: ReturnType<typeof SqliteBunRuntime.sqlClient>,
  ) {
    const createFirstTable = FirstUsers.write()
    const createSecondTable = SecondUsers.write()
    const createTables = Effect.all([createFirstTable, createSecondTable])

    return yield* pipe(createTables, Effect.provide(adapter))
  })

  const expectTablesCreated = (created: ReadonlyArray<void>) => {
    const expectation = expect(created)
    expectation.toEqual([undefined, undefined])

    return created
  }

  const verifiesGeneratedArticle = Effect.fn(
    "SqliteBun.verifiesGeneratedArticle",
  )(function* (article: typeof ArticleSchema.Type) {
    const createArticle = insertedArticle(article)
    const created = yield* withTemporaryDatabase(createArticle)

    expect(created.name).toBe(article.name)
    expect(created.rating).toBe(article.rating)
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(Articles.identifier).toBe("id")
    expect(Articles.identifierSchema).toBe(Articles.rowSchema.fields.id)

    const firstField = pipe(Articles.fields, Array.get(0), Option.getOrThrow)
    const generation = Option.getOrThrow(firstField.generation)

    expect(generation).toBe("uuidv7")
  })

  const verifiesMultipleTables = Effect.fn("SqliteBun.verifiesMultipleTables")(
    function* () {
      const created = yield* withTemporaryDatabase(createMultipleTables)

      expectTablesCreated(created)
    },
  )


  it.effect("creates a derived table and runs authored CRUD queries", () =>
    withTemporaryDatabase(runCrudContract))

  it.effect("backs a shared persisted reference with authored queries", () =>
    withTemporaryDatabase(runPersistedRefContract))

  it.effect.prop(
    "adds and generates a UUIDv7 identifier when the schema has none",
    [ArticleSchema],
    ([article]) => verifiesGeneratedArticle(article),
    { fastCheck: { numRuns: 10 } },
  )

  it.effect("uses an explicit domain identifier instead of the UUIDv7 default", () =>
    Effect.sync(() => {
      expect(Users.identifier).toBe("id")
      expect(Users.identifierSchema).toBe(UserIdSchema)
      expect(Users.rowSchema).toBe(UserSchema)

      const firstField = pipe(Users.fields, Array.get(0), Option.getOrThrow)
      const hasGeneration = Option.isSome(firstField.generation)

      expect(hasGeneration).toBe(false)
    }))

  it.effect("keeps database and codec services as execution requirements", () =>
    Effect.sync(() => {
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

      expect(queryRequiresDatabase).toBe(true)
      expect(queryRequiresCodec).toBe(true)
      expect(CreateUser.table).toBe(Users)
      expect(FindUser.Request).toBe(UserIdSchema)
      expect(FindUser.Result).toBe(OptionalUserSchema)
    }))

  it.effect(
    "supports multiple table definitions through one runtime layer",
    verifiesMultipleTables,
  )
})
