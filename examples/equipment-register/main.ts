import { Effect, pipe } from "effect"
import * as ApplicationBun from "effect-domains/application-bun"
import { EquipmentRegisterApplication } from "./application.ts"
import { EquipmentRegisterMigrations } from "./migrations.ts"


const program = ApplicationBun.runApplication(EquipmentRegisterApplication, {
  database: { migrations: EquipmentRegisterMigrations },
  ui: {
    presentation: {
      title: "Equipment register",
      description: "Register equipment, track its location, and maintain its service status.",
    },
  },
})

pipe(program, ApplicationBun.runMain, Effect.runSync)
