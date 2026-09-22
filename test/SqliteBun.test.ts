import { describe, expect, it } from "@effect/vitest"
import { mkdtempDisposableSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BunServices } from "@effect/platform-bun"

import {
  Array,
  Context,
  Effect,
  Equivalence,
  flow,
  Function,
  Layer,
  Option,
  pipe,
  Record,
  Result,
  Schema,
  SchemaGetter,
  Struct,
} from "effect"

import { identifier } from "effect-domains/domain"

import {
  RepositoryAccess,
  RepositoryOrder,
  RepositorySelect,
  RepositoryStore,
} from "effect-domains/repository-store"

import { Policy } from "effect-domains/policy"

import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { Table } from "effect-domains/table"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { prepareTables } from "./prepare-tables.ts"
import { adapterContract } from "./adapter-contract/effects.ts"

describe("Bun SQLite tables and authored operations", () => {
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

  const Users = Table.make({ name: "users", schema: UserSchema })

  const CreateUser = SqlSchema.findOne({
    Request: UserSchema,
    Result: UserSchema,
    execute: Effect.fn("CreateUser.implementation")(function* (user) {
      const db = yield* SqlClient.SqlClient
      const insert = db.insert(user)

      return yield* db<Readonly<Record<string, unknown>>>`
        INSERT INTO ${db(Users.name)} ${insert}
        RETURNING *
      `
    }),
  })

  const FindUser = SqlSchema.findOneOption({
    Request: UserIdSchema,
    Result: UserSchema,
    execute: Effect.fn("FindUser.implementation")(function* (id) {
      const db = yield* SqlClient.SqlClient

      return yield* db<Readonly<Record<string, unknown>>>`
        SELECT * FROM ${db(Users.name)}
        WHERE ${db(Users.identifier)} = ${id}
        LIMIT 1
      `
    }),
  })

  const UpdateUser = SqlSchema.findOneOption({
    Request: UserSchema,
    Result: UserSchema,
    execute: Effect.fn("UpdateUser.implementation")(function* (user) {
      const db = yield* SqlClient.SqlClient
      const identifier = user[Users.identifier]
      const changes = db.update(user, [Users.identifier])

      return yield* db<Readonly<Record<string, unknown>>>`
        UPDATE ${db(Users.name)}
        SET ${changes}
        WHERE ${db(Users.identifier)} = ${identifier}
        RETURNING *
      `
    }),
  })

  const encodeUserId = Schema.encodeEffect(UserIdSchema)

  const DeleteUser = Effect.fn("DeleteUser.implementation")(function* (
    id: typeof UserIdSchema.Type,
  ) {
    const db = yield* SqlClient.SqlClient
    const encodedId = yield* encodeUserId(id)

    const rows = yield* db<Readonly<Record<string, unknown>>>`
      DELETE FROM ${db(Users.name)}
      WHERE ${db(Users.identifier)} = ${encodedId}
      RETURNING ${db(Users.identifier)}
    `

    return rows.length > 0
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

  const StoreRowSchema = Schema.Struct({
    id: UserIdSchema,
    bucket: Schema.String,
    label: Schema.String,
    rank: Schema.Int,
  })

  const StoreRows = Table.make({
    name: "store_rows",
    schema: StoreRowSchema,
    relations: { unique: [{ name: "store_rows_bucket_label_key", fields: ["bucket", "label"] }] },
  })

  const storePolicy = Policy.constant(true)
  const storeAccess = new RepositoryAccess({ policy: storePolicy, subject: {} })

  const storedRow = (id: string, bucket: string, label: string, rank: number) =>
    StoreRowSchema.make({ id: UserIdSchema.make(id), bucket, label, rank })

  const CreateArticle = SqlSchema.findOne({
    Request: ArticleSchema,
    Result: Articles.rowSchema,
    execute: Effect.fn("CreateArticle.implementation")(function* (article) {
      const db = yield* SqlClient.SqlClient

      return yield* db<Readonly<Record<string, unknown>>>`
        INSERT INTO ${db(Articles.name)} ${db.insert(article)}
        RETURNING *
      `
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
      use: (
        adapter: ReturnType<typeof SqliteBunRuntime.sqlClient>,
        filename: string,
      ) => Effect.Effect<A, E, R>,
    ) {
      const directory = yield* Effect.acquireRelease(
        makeDatabaseDirectory,
        removeDatabaseDirectory,
      )

      const filename = join(directory.path, "test.sqlite")
      const adapter = SqliteBunRuntime.sqlClient(filename, { migrations: [] })

      return yield* use(adapter, filename)
    },
  )

  const insertedArticle = (article: typeof ArticleSchema.Type) =>
    Effect.fn("SqliteBun.insertedArticle")(function* (
      adapter: ReturnType<typeof SqliteBunRuntime.sqlClient>,
    ) {
      return yield* pipe(
        Effect.gen(function* () {
          yield* prepareTables([Articles])

          return yield* CreateArticle(article)
        }),
        Effect.provide(adapter),
      )
    })

  const runCrudContract = (adapter: ReturnType<typeof SqliteBunRuntime.sqlClient>) =>
    pipe(
      Effect.gen(function* () {
        yield* prepareTables([Users])

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
          create: { execute: CreateUser },
          read: { execute: FindUser },
          update: { execute: UpdateUser },
          delete: { execute: DeleteUser },
        })
      }),
      Effect.provide(adapter),
      Effect.provide(PrefixLive),
    )



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
  })



  const paginatedStoreRows = (adapter: ReturnType<typeof SqliteBunRuntime.sqlClient>) =>
    pipe(
      Effect.gen(function* () {
        yield* prepareTables([StoreRows])

        const store = yield* RepositoryStore

        const rows = [
          storedRow("a2", "a", "two", 2),
          storedRow("a1", "a", "one", 1),
          storedRow("a0", "a", "zero", 0),
          storedRow("b2", "b", "two", 2),
          storedRow("b1", "b", "one", 1),
          storedRow("c3", "c", "three", 3),
        ]

        const insertRow = (row: typeof StoreRowSchema.Type) => store.insert(StoreRows, row)

        yield* Effect.forEach(rows, insertRow)

        const order = [
          new RepositoryOrder({ field: "bucket", direction: "asc" }),
          new RepositoryOrder({ field: "rank", direction: "desc" }),
          new RepositoryOrder({ field: "id", direction: "asc" }),
        ]

        const firstAfter = Option.none()

        const firstSelection = new RepositorySelect({
          filter: {},
          range: { rank: { from: 1, to: 2 } },
          order,
          after: firstAfter,
          limit: 2,
        })

        const first = yield* store.select(StoreRows, firstSelection, storeAccess)
        const secondAfter = Option.some({ bucket: "a", rank: 1, id: "a1" })

        const secondSelection = new RepositorySelect({
          filter: {},
          range: { rank: { from: 1, to: 2 } },
          order,
          after: secondAfter,
          limit: 2,
        })

        const second = yield* store.select(StoreRows, secondSelection, storeAccess)
        const getStoreRowId = flow(Record.get("id"), Option.getOrThrow)
        const firstIds = Array.map(first, getStoreRowId)
        const secondIds = Array.map(second, getStoreRowId)

        expect(firstIds).toEqual(["a2", "a1"])
        expect(secondIds).toEqual(["b2", "b1"])
      }),
      Effect.provide(adapter),
    )

  const guardedUpdate = (adapter: ReturnType<typeof SqliteBunRuntime.sqlClient>) =>
    pipe(
      Effect.gen(function* () {
        yield* prepareTables([StoreRows])

        const store = yield* RepositoryStore
        const original = storedRow("guarded", "a", "guarded", 1)

        yield* store.insert(StoreRows, original)

        const updated = yield* store.update(
          StoreRows,
          { ...original, rank: 2 },
          storeAccess,
          { rank: 0 },
        )

        const isUnchanged = Option.isNone(updated)

        expect(isUnchanged).toBe(true)
      }),
      Effect.provide(adapter),
    )

  const declaredUniqueConstraints = (adapter: ReturnType<typeof SqliteBunRuntime.sqlClient>) =>
    pipe(
      Effect.gen(function* () {
        yield* prepareTables([StoreRows])

        const store = yield* RepositoryStore
        const firstRow = storedRow("first", "a", "duplicate", 1)

        yield* store.insert(StoreRows, firstRow)

        const secondRow = storedRow("second", "a", "duplicate", 2)
        const insertingSecondRow = store.insert(StoreRows, secondRow)
        const result = yield* Effect.result(insertingSecondRow)
        const isUniqueViolation = Result.isFailure(result)

        expect(isUniqueViolation).toBe(true)

        if (isUniqueViolation) {
          expect(result.failure).toMatchObject({
            _tag: "UniqueViolation",
            resource: "store_rows",
          })

          const failureAssertion = expect(result.failure)

          failureAssertion.not.toHaveProperty("constraint")
          failureAssertion.not.toHaveProperty("fields")
        }

        const duplicateIdRow = storedRow("first", "b", "other", 2)
        const insertingDuplicateIdRow = store.insert(StoreRows, duplicateIdRow)
        const primaryKey = yield* Effect.result(insertingDuplicateIdRow)

        expect(primaryKey).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "UniqueViolation",
            resource: "store_rows",
          },
        })
      }),
      Effect.provide(adapter),
    )

  const selectOne = Effect.fn("SqliteBun.selectOne")(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql`SELECT 1`
  })

  const rejectsPrivateClient = Effect.fn("SqliteBun.rejectsPrivateClient")(function* (
    application: ReturnType<typeof SqliteBunRuntime.sqlClient>,
    filename: string,
  ) {
    const privateClient = SqliteBunRuntime.privateClient({
      application: "effect-domains-test",
      purpose: "identity",
      filename,
    })

    const query = selectOne()

    const protectedQuery = pipe(
      query,
      Effect.provide(privateClient),
      Effect.provide(application),
      Effect.provide(BunServices.layer),
    )

    const result = yield* Effect.result(protectedQuery)

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "PrivateDatabaseConflict" },
    })
  })

  const privateIdentityClient = SqliteBunRuntime.privateClient({
    application: "effect-domains-test",
    purpose: "identity",
    filename: ":memory:",
  })

  const ambientApplicationClient = SqliteBunRuntime.sqlClient(":memory:", { migrations: [] })

  const opensPrivateClient = pipe(
    Effect.fn("SqliteBun.opensPrivateClient")(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<Readonly<{ value: number }>>`SELECT 1 AS value`

      expect(rows).toEqual([{ value: 1 }])
    })(),
    Effect.provide(privateIdentityClient),
    Effect.provide(ambientApplicationClient),
    Effect.provide(BunServices.layer),
  )

  const paginatedStoreRowsEffect = withTemporaryDatabase(paginatedStoreRows)
  const guardedUpdateEffect = withTemporaryDatabase(guardedUpdate)
  const declaredUniqueConstraintsEffect = withTemporaryDatabase(declaredUniqueConstraints)
  const rejectsPrivateClientEffect = withTemporaryDatabase(rejectsPrivateClient)
  const crudContractEffect = withTemporaryDatabase(runCrudContract)
  const paginatedStoreRowsTest = Function.constant(paginatedStoreRowsEffect)
  const guardedUpdateTest = Function.constant(guardedUpdateEffect)
  const declaredUniqueConstraintsTest = Function.constant(declaredUniqueConstraintsEffect)
  const rejectsPrivateClientTest = Function.constant(rejectsPrivateClientEffect)
  const opensPrivateClientTest = Function.constant(opensPrivateClient)
  const crudContractTest = Function.constant(crudContractEffect)

  it.effect("applies inclusive bounds and two-field descending keyset pagination", paginatedStoreRowsTest)
  it.effect("returns None when a guarded update no longer matches", guardedUpdateTest)
  it.effect("reports sanitized unique violations", declaredUniqueConstraintsTest)
  it.effect("rejects a private client targeting the application database", rejectsPrivateClientTest)
  it.effect("opens a private SQLite client over an ambient application client", opensPrivateClientTest)
  it.effect("creates a derived table and runs authored CRUD operations", crudContractTest)


  it.effect.prop(
    "adds and generates a UUIDv7 identifier when the schema has none",
    [ArticleSchema],
    ([article]) => verifiesGeneratedArticle(article),
    { fastCheck: { numRuns: 10 } },
  )


  {
      const requiresDatabase = true satisfies (
        SqlClient.SqlClient extends Effect.Services<
          ReturnType<typeof CreateUser>
        > ? true : false
      )

      const requiresCodec = true satisfies (
        Context.Service.Identifier<typeof CodecPrefix> extends Effect.Services<
          ReturnType<typeof CreateUser>
        > ? true : false
      )

      void requiresDatabase
      void requiresCodec
  }
})
