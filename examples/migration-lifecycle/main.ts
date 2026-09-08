import { BunRuntime } from "@effect/platform-bun"
import { ApplicationBun } from "effect-domains/application-bun"
import { MigrationLifecycleApplication } from "./application.ts"

const manifest = Bun.fileURLToPath(new URL("./migrations/manifest.json", import.meta.url))

BunRuntime.runMain(ApplicationBun.run(MigrationLifecycleApplication, {
  database: { manifest },
}))
