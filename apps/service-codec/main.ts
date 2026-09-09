import { BunRuntime } from "@effect/platform-bun"
import { Layer, pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { NotesApplication } from "./application.ts"
import { StoragePrefix } from "./storage.ts"

const prefix = Layer.succeed(StoragePrefix, { value: "stored:" })
const services = Layer.mergeAll(prefix, ExampleAuthentication)

const manifest = new URL("./migrations/manifest.json", import.meta.url)

pipe(ApplicationBun.run(NotesApplication, {
  database: { manifest },
  services,
  admin: true,
}), BunRuntime.runMain)
