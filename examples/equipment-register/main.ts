import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { EquipmentRegisterApplication } from "./application.ts"
import { EquipmentRegisterMigrations } from "./migrations.ts"


pipe(ApplicationBun.run(EquipmentRegisterApplication, {
  database: { migrations: EquipmentRegisterMigrations },
}), BunRuntime.runMain)
