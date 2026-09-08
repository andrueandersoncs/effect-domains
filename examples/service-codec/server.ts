import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer, Schema, pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { NotesApplication, NotesHandlers } from "./application.ts"
import { NotesMigrations } from "./migrations.ts"
import { NotesSqlite } from "./sqlite.ts"
import { StoragePrefix } from "./storage.ts"

const notesServer = Effect.gen(function* () {
  const filename = yield* pipe(
    Config.schema(Schema.NonEmptyString, "SERVICE_CODEC_DB"),
    Config.withDefault("service-codec.sqlite"),
  )

  const runtime = SqliteBunRuntime.sqlClient(filename, {
    migrations: NotesMigrations,
  })

  const prefix = Layer.succeed(StoragePrefix, { value: "stored:" })
  const services = Layer.provide(NotesSqlite, prefix)

  yield* ApplicationBun.serve({
    application: NotesApplication,
    handlers: NotesHandlers,
    runtime,
    services,
    initialize: Effect.void,
  })
})

BunRuntime.runMain(notesServer as Effect.Effect<void, any>)
