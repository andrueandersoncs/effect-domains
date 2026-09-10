import { BunRuntime } from "@effect/platform-bun"

import {
  Array,
  Config,
  Effect,
  Option,
  Schema,
  pipe,
} from "effect"

import { SqlClient } from "effect/unstable/sql"
import { SchemaStore } from "effect-domains/migrations"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { LegacyDocumentsResource } from "./legacy.ts"
import { MigrationLifecycleMigrations } from "./migrations.ts"

const seedTitle = "Migration guide"

const initialMigration = pipe(
  MigrationLifecycleMigrations,
  Array.head,
  Option.getOrThrow,
)

const seedVersionOneDocument = Effect.gen(function* () {
  const filename = yield* pipe(
    Config.schema(Schema.NonEmptyString, "MIGRATION_LIFECYCLE_DB"),
    Config.withDefault("migration-lifecycle.sqlite"),
  )

  const runtime = SqliteBunRuntime.sqlClient(filename, {
    migrations: [initialMigration],
  })

  const seed = Effect.gen(function* () {
    const schemaStore = yield* SchemaStore
    yield* schemaStore.prepare(initialMigration.to.tables)

    const sql = yield* SqlClient.SqlClient

    const documents = yield* sql`
      SELECT title FROM ${sql(LegacyDocumentsResource.table.name)} WHERE title = ${seedTitle} LIMIT 1
    `

    const alreadySeeded = Array.isReadonlyArrayNonEmpty(documents)

    if (!alreadySeeded) {
      yield* LegacyDocumentsResource.repository.create({ title: seedTitle })
    }
  })

  yield* pipe(seed, Effect.provide(runtime))
})

BunRuntime.runMain(seedVersionOneDocument)
