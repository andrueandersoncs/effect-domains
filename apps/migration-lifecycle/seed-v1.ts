import { BunRuntime } from "@effect/platform-bun"

import {
  Array,
  Config,
  Effect,
  Option,
  Schema,
  Struct,
  pipe,
} from "effect"

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

    const documents = yield* LegacyDocumentsResource.repository.list()

    const alreadySeeded = pipe(
      documents,
      Array.map(Struct.get("title")),
      Array.contains(seedTitle),
    )

    if (!alreadySeeded) {
      yield* LegacyDocumentsResource.repository.create({ title: seedTitle })
    }
  })

  yield* pipe(seed, Effect.provide(runtime))
})

BunRuntime.runMain(seedVersionOneDocument)
