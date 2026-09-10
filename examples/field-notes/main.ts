import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer, pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { FieldNotesApplication } from "./application.ts"
import { FieldNoteEncryption, makeFieldNoteEncryption } from "./storage.ts"
import { FieldNotesMigrations } from "./migrations.ts"

const encryption = pipe(Effect.gen(function* () {
  const encodedKey = yield* Config.string("FIELD_NOTES_ENCRYPTION_KEY")
  return yield* makeFieldNoteEncryption(encodedKey)
}), Layer.effect(FieldNoteEncryption))

const services = Layer.mergeAll(encryption, ExampleAuthentication)

pipe(ApplicationBun.run(FieldNotesApplication, {
  database: { migrations: FieldNotesMigrations },
  services,
  admin: true,
}), BunRuntime.runMain)
