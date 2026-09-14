import { BunRuntime } from "@effect/platform-bun"

import {
  Array,
  Config,
  Effect,
  Option,
  Schema,
  pipe,
} from "effect"

import { SchemaStore } from "effect-domains/migrations"
import { Resource } from "effect-domains/resource"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { LegacyDocumentsResource } from "./legacy.ts"
import { EditorialCalendarMigrations } from "./migrations.ts"

const seedTitle = "Autumn trail guide"
const seedId = "018f2520-1468-7e56-9f89-1b2d3c4e5f60"

const initialMigration = pipe(
  EditorialCalendarMigrations,
  Array.head,
  Option.getOrThrow,
)

const seedVersionOneDraft = Effect.gen(function* () {
  const filename = yield* pipe(
    Config.schema(Schema.NonEmptyString, "EDITORIAL_CALENDAR_DB"),
    Config.withDefault("data/editorial-calendar.sqlite"),
  )

  const runtime = SqliteBunRuntime.sqlClient(filename, {
    migrations: [initialMigration],
  })

  const seed = Effect.gen(function* () {
    const schemaStore = yield* SchemaStore
    yield* schemaStore.prepare(initialMigration.to.tables)

    yield* Resource.repository(LegacyDocumentsResource).ensure({ id: seedId, title: seedTitle })
  })

  yield* pipe(seed, Effect.provide(runtime))
})

BunRuntime.runMain(seedVersionOneDraft)
