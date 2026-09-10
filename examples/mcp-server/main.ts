import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { McpServerApplication } from "./application.ts"
import { McpMigrations } from "./migrations.ts"


pipe(ApplicationBun.run(McpServerApplication, {
  database: { migrations: McpMigrations },
}), BunRuntime.runMain)
