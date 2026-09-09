import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "../authentication.ts"
import { NotesApplication } from "./application.ts"
import { StoragePrefix } from "./storage.ts"

const prefix = Layer.succeed(StoragePrefix, { value: "stored:" })
const services = Layer.mergeAll(prefix, ExampleAuthentication)
const manifestUrl = new URL("./migrations/manifest.json", import.meta.url)
const manifest = Bun.fileURLToPath(manifestUrl)
const filename = Option.none()

const program = ApplicationBun.run(NotesApplication, {
  database: { manifest, filename },
  services,
  initialize: Effect.void,
})

BunRuntime.runMain(program)
