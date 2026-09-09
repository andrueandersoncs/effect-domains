import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { MigrationLifecycleApplication } from "./application.ts"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

pipe(ApplicationBun.run(MigrationLifecycleApplication, {
  database: { manifest },
  admin: true,
}), BunRuntime.runMain)
