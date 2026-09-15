import { Config, Effect, Layer, pipe } from "effect"
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


const program = ApplicationBun.run(FieldNotesApplication, {
  database: { migrations: FieldNotesMigrations },
  services,
  ui: {
    presentation: {
      title: "Field notes",
      description: "Record and share encrypted field reports under the application authorization policy.",
    },
  },
})

pipe(program, ApplicationBun.runMain)
