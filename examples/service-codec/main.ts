import { BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { NotesApplication } from "./application.ts"
import { StoragePrefix } from "./storage.ts"

const services = Layer.succeed(StoragePrefix, { value: "stored:" })
const manifest = Bun.fileURLToPath(new URL("./migrations/manifest.json", import.meta.url))

BunRuntime.runMain(ApplicationBun.run(NotesApplication, {
  database: { manifest },
  services,
}))
