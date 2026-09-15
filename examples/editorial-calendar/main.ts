import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { EditorialCalendarApplication } from "./application.ts"
import { EditorialCalendarMigrations } from "./migrations.ts"


const program = ApplicationBun.run(EditorialCalendarApplication, {
  database: { migrations: EditorialCalendarMigrations },
  ui: {
    presentation: {
      title: "Editorial calendar",
      description: "Plan articles across website, newsletter, and print publication.",
    },
  },
})

pipe(program, ApplicationBun.runMain)
