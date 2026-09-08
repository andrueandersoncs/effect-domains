import { BunRuntime } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { AuthoredSqlApplication } from "./application.ts"
import { BooksSqlite } from "./sqlite.ts"

const manifestUrl = new URL("./migrations/manifest.json", import.meta.url)
const manifest = Bun.fileURLToPath(manifestUrl)
const filename = Option.none()

const program = ApplicationBun.run(AuthoredSqlApplication, {
  database: { manifest, filename },
  services: BooksSqlite,
  initialize: Effect.void,
})

BunRuntime.runMain(program)
