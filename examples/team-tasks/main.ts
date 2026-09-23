import { pipe } from "effect"
import * as ApplicationBun from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { TeamTasksApplication } from "./application.ts"
import { TeamTasksMigrations } from "./migrations.ts"


const services = ExampleIdentity.layer("team-tasks")

const program = ApplicationBun.runApplication(TeamTasksApplication, {
  database: { migrations: TeamTasksMigrations },
  services,
  ui: {
    presentation: {
      title: "Team tasks",
      description: "Organize team work and track what is ready to close.",
    },
  },
})

pipe(program, ApplicationBun.runMain)
