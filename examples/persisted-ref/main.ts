import { BunRuntime } from "@effect/platform-bun"
import { ApplicationBun } from "effect-domains/application-bun"
import { PersistedRefApplication } from "./application.ts"
import { CounterSqlite } from "./sqlite.ts"

const manifest = Bun.fileURLToPath(new URL("./migrations/manifest.json", import.meta.url))

BunRuntime.runMain(ApplicationBun.run(PersistedRefApplication, {
  database: { manifest },
  services: CounterSqlite,
}))
