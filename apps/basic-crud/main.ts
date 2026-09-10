import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { BasicCrudApplication } from "./application.ts"
import { BookMigrations } from "./migrations.ts"


pipe(ApplicationBun.run(BasicCrudApplication, {
  database: { migrations: BookMigrations },
  admin: true,
}), BunRuntime.runMain)
