import { BunRuntime } from "@effect/platform-bun"
import { ApplicationBun } from "effect-domains/application-bun"
import { BasicCrudApplication } from "./application.ts"
import { BooksSqlite } from "./sqlite.ts"

const manifest = Bun.fileURLToPath(new URL("./migrations/manifest.json", import.meta.url))

BunRuntime.runMain(ApplicationBun.run(BasicCrudApplication, {
  database: { manifest },
  services: BooksSqlite,
}))
