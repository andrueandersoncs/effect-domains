import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { AuthoredSqlApplication } from "./application.ts"
import { BookMigrations } from "./migrations.ts"


pipe(ApplicationBun.run(AuthoredSqlApplication, {
  database: { migrations: BookMigrations },
  admin: true,
}), BunRuntime.runMain)
