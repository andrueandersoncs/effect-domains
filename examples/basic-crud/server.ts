import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Schema, pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { BasicCrudApplication, BasicCrudHandlers } from "./application.ts"
import { BasicCrudMigrations } from "./migrations.ts"
import { BooksSqlite } from "./sqlite.ts"

const basicCrudServer = Effect.gen(function* () {
  const filename = yield* pipe(
    Config.schema(Schema.NonEmptyString, "BASIC_CRUD_DB"),
    Config.withDefault("basic-crud.sqlite"),
  )

  const runtime = SqliteBunRuntime.sqlClient(filename, {
    migrations: BasicCrudMigrations,
  })

  yield* ApplicationBun.serve({
    application: BasicCrudApplication,
    handlers: BasicCrudHandlers,
    runtime,
    services: BooksSqlite,
    initialize: Effect.void,
  })
})

BunRuntime.runMain(basicCrudServer as Effect.Effect<void, any>)
