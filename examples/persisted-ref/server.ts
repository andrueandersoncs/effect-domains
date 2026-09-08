import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Schema, pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { PersistedRefApplication, PersistedRefHandlers } from "./application.ts"
import { CounterMigrations } from "./migrations.ts"
import { CounterSqlite } from "./sqlite.ts"

const persistedRefServer = Effect.gen(function* () {
  const filename = yield* pipe(
    Config.schema(Schema.NonEmptyString, "PERSISTED_REF_DB"),
    Config.withDefault("persisted-ref.sqlite"),
  )

  const runtime = SqliteBunRuntime.sqlClient(filename, {
    migrations: CounterMigrations,
  })

  yield* ApplicationBun.serve({
    application: PersistedRefApplication,
    handlers: PersistedRefHandlers,
    runtime,
    services: CounterSqlite,
    initialize: Effect.void,
  })
})

BunRuntime.runMain(persistedRefServer as Effect.Effect<void, any>)
