import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReadingListApplication } from "./application.ts"
import { ReadingListMigrations } from "./migrations.ts"


const program = ApplicationBun.run(ReadingListApplication, {
  database: { migrations: ReadingListMigrations },
  ui: {
    presentation: {
      title: "Reading list",
      description: "Maintain a reading backlog, record progress, and rate finished books.",
    },
  },
  telemetry: {
    resource: {
      serviceName: "reading-list",
      attributes: { "deployment.environment.name": "local" },
    },
  },
})

pipe(program, ApplicationBun.runMain)
