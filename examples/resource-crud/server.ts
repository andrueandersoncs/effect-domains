import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer, Schema, pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { ResourceCrudApplication } from "./application.ts"
import { TodoMigrations } from "./migrations.ts"

const resourceCrudServer = Effect.gen(function* () {
  const filename = yield* pipe(
    Config.schema(Schema.NonEmptyString, "RESOURCE_CRUD_DB"),
    Config.withDefault("resource-crud.sqlite"),
  )

  const runtime = SqliteBunRuntime.sqlClient(filename, {
    migrations: TodoMigrations,
  })

  yield* ApplicationBun.serve({
    application: ResourceCrudApplication,
    handlers: ResourceCrudApplication.handlers,
    runtime,
    services: Layer.empty,
    initialize: Effect.void,
  })
})

BunRuntime.runMain(resourceCrudServer as Effect.Effect<void, any>)
