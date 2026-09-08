import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { NotesApplication } from "./application.ts"
import { StoragePrefix } from "./storage.ts"

const services = Layer.succeed(StoragePrefix, { value: "stored:" })
const manifestUrl = new URL("./migrations/manifest.json", import.meta.url)
const manifest = Bun.fileURLToPath(manifestUrl)
const filename = Option.none()

const program = ApplicationBun.run(NotesApplication, {
  database: { manifest, filename },
  services,
  initialize: Effect.void,
})

BunRuntime.runMain(program)
