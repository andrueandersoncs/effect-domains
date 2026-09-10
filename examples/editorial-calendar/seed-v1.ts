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
import { EditorialCalendarMigrations } from "./migrations.ts"

const seedTitle = "Autumn trail guide"

const initialMigration = pipe(
  EditorialCalendarMigrations,
  Array.head,
  Option.getOrThrow,
)

const seedVersionOneDraft = Effect.gen(function* () {
  const filename = yield* pipe(
    Config.schema(Schema.NonEmptyString, "EDITORIAL_CALENDAR_DB"),
    Config.withDefault("editorial-calendar.sqlite"),
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

BunRuntime.runMain(seedVersionOneDraft)
