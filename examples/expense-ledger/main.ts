import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExpenseLedgerApplication } from "./application.ts"
import { ExpenseLedgerMigrations } from "./migrations.ts"

pipe(ApplicationBun.run(ExpenseLedgerApplication, {
  database: { migrations: ExpenseLedgerMigrations },
  admin: true,
}), BunRuntime.runMain)
