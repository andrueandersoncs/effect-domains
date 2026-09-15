import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { RepairWorkshopApplication } from "./application.ts"
import { RepairWorkshopMigrations } from "./migrations.ts"


const program = ApplicationBun.run(RepairWorkshopApplication, {
  database: { migrations: RepairWorkshopMigrations },
  ui: {
    presentation: {
      title: "Repair workshop",
      description: "Manage customers, technicians, repairs, and the joined workshop board.",
    },
  },
})

pipe(program, ApplicationBun.runMain)
