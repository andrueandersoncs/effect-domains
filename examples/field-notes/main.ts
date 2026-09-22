import { Layer, pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { FieldNotesApplication } from "./application.ts"
import { FieldNotesMigrations } from "./migrations.ts"
import { FieldNoteEncryptionLive } from "./storage.ts"

const identity = ExampleIdentity.layer("field-notes")
const services = Layer.mergeAll(FieldNoteEncryptionLive, identity)



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
