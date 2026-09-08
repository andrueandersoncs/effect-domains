import { BunRuntime } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { PersistedRefApplication } from "./application.ts"
import { CounterSqlite } from "./sqlite.ts"

const manifestUrl = new URL("./migrations/manifest.json", import.meta.url)
const manifest = Bun.fileURLToPath(manifestUrl)
const filename = Option.none()

const program = ApplicationBun.run(PersistedRefApplication, {
  database: { manifest, filename },
  services: CounterSqlite,
  initialize: Effect.void,
})

BunRuntime.runMain(program)
