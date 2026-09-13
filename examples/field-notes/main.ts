import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer, pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { FieldNotesApplication } from "./application.ts"
import { FieldNotesMigrations } from "./migrations.ts"
import { FieldNoteEncryption, makeFieldNoteEncryption } from "./storage.ts"

const encryption = pipe(Effect.gen(function* () {
  const encodedKey = yield* Config.string("FIELD_NOTES_ENCRYPTION_KEY")
  return yield* makeFieldNoteEncryption(encodedKey)
}), Layer.effect(FieldNoteEncryption))

const identity = ExampleIdentity.layer("field-notes")
const services = Layer.mergeAll(encryption, identity)

const webBase = new URL("./web/", import.meta.url)

const webSite = StaticSpa.site({
  title: "Field notes",
  accent: "#854d0e",
  base: webBase,
})

const web = StaticSpa.layerHttp(webSite)

pipe(ApplicationBun.run(FieldNotesApplication, {
  database: { migrations: FieldNotesMigrations },
  services,
  admin: true,
  routes: web,
}), BunRuntime.runMain)
