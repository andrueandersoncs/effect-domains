import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer, pipe } from "effect"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { FieldNotesApplication } from "./application.ts"
import { FieldNotesMigrations } from "./migrations.ts"
import { FieldNoteEncryption, makeFieldNoteEncryption } from "./storage.ts"
import { FieldNotesWebAssets } from "./web/assets.ts"

const encryption = pipe(Effect.gen(function* () {
  const encodedKey = yield* Config.string("FIELD_NOTES_ENCRYPTION_KEY")
  return yield* makeFieldNoteEncryption(encodedKey)
}), Layer.effect(FieldNoteEncryption))

const services = Layer.mergeAll(encryption, ExampleIdentity)

const web = ExampleWeb.layerHttp({
  title: "Field notes",
  accent: "#854d0e",
  ...FieldNotesWebAssets,
})

pipe(ApplicationBun.run(FieldNotesApplication, {
  database: { migrations: FieldNotesMigrations },
  services,
  admin: true,
  routes: web,
}), BunRuntime.runMain)
