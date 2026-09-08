import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ResourceCrudApplication } from "./application.ts"

const manifestUrl = new URL("./migrations/manifest.json", import.meta.url)
const manifest = Bun.fileURLToPath(manifestUrl)
const filename = Option.none()

const program = ApplicationBun.run(ResourceCrudApplication, {
  database: { manifest, filename },
  services: Layer.empty,
  initialize: Effect.void,
})

BunRuntime.runMain(program)
