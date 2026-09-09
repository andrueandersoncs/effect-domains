import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { PersistedRefApplication } from "./application.ts"
import { CounterSqlite } from "./sqlite.ts"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

pipe(ApplicationBun.run(PersistedRefApplication, {
  database: { manifest },
  services: CounterSqlite,
  admin: true,
}), BunRuntime.runMain)
