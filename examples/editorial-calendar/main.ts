import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { EditorialCalendarApplication } from "./application.ts"
import { EditorialCalendarMigrations } from "./migrations.ts"


pipe(ApplicationBun.run(EditorialCalendarApplication, {
  database: { migrations: EditorialCalendarMigrations },
  admin: true,
}), BunRuntime.runMain)
