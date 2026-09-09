import { ApplicationBun } from "effect-domains/application-bun"
import { MigrationLifecycleApplication } from "./application.ts"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

ApplicationBun.runMain(MigrationLifecycleApplication, {
  database: { manifest },
  admin: true,
})
