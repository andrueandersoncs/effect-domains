import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { AuthoredSqlApplication } from "./application.ts"
import { BooksSqlite } from "./sqlite.ts"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

pipe(ApplicationBun.run(AuthoredSqlApplication, {
  database: { manifest },
  services: BooksSqlite,
  admin: true,
}), BunRuntime.runMain)
