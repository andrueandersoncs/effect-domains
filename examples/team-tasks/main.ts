import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { TeamTasksApplication } from "./application.ts"
import { TeamTasksMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)
const web = StaticSpa.layerHttp({ title: "Team tasks", accent: "#0f766e", base: webBase })

const services = ExampleIdentity.layer("team-tasks")

const program = ApplicationBun.run(TeamTasksApplication, {
  database: { migrations: TeamTasksMigrations },
  services,
  admin: true,
  routes: web,
})

pipe(program, ApplicationBun.runMain)
