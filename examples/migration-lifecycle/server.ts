import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer, Schema, pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { MigrationLifecycleApplication } from "./application.ts"
import { MigrationLifecycleMigrations } from "./migrations.ts"

const migrationLifecycleServer = Effect.gen(function* () {
  const filename = yield* pipe(
    Config.schema(Schema.NonEmptyString, "MIGRATION_LIFECYCLE_DB"),
    Config.withDefault("migration-lifecycle.sqlite"),
  )

  const runtime = SqliteBunRuntime.sqlClient(filename, {
    migrations: MigrationLifecycleMigrations,
  })

  yield* ApplicationBun.serve({
    application: MigrationLifecycleApplication,
    handlers: MigrationLifecycleApplication.handlers,
    runtime,
    services: Layer.empty,
    initialize: Effect.void,
  })
})

BunRuntime.runMain(migrationLifecycleServer as Effect.Effect<void, any>)
