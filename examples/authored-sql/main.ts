import { ApplicationBun } from "effect-domains/application-bun"
import { AuthoredSqlApplication } from "./application.ts"
import { BooksSqlite } from "./sqlite.ts"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

ApplicationBun.runMain(AuthoredSqlApplication, {
  database: { manifest },
  services: BooksSqlite,
  admin: true,
})
