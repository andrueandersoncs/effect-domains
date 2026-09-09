import { Layer } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { NotesApplication } from "./application.ts"
import { StoragePrefix } from "./storage.ts"

const prefix = Layer.succeed(StoragePrefix, { value: "stored:" })
const services = Layer.mergeAll(prefix, ExampleAuthentication)

const manifest = new URL("./migrations/manifest.json", import.meta.url)

ApplicationBun.runMain(NotesApplication, {
  database: { manifest },
  services,
  admin: true,
})
