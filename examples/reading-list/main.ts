import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReadingListApplication } from "./application.ts"
import { ReadingListMigrations } from "./migrations.ts"

pipe(ApplicationBun.run(ReadingListApplication, {
  database: { migrations: ReadingListMigrations },
  admin: true,
}), BunRuntime.runMain)
