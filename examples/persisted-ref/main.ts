import { ApplicationBun } from "effect-domains/application-bun"
import { PersistedRefApplication } from "./application.ts"
import { CounterSqlite } from "./sqlite.ts"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

ApplicationBun.runMain(PersistedRefApplication, {
  database: { manifest },
  services: CounterSqlite,
  admin: true,
})
