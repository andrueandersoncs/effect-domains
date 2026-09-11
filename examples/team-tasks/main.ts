import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { TeamTasksApplication } from "./application.ts"
import { TeamTasksMigrations } from "./migrations.ts"
import { TeamTasksWebAssets } from "./web/assets.ts"

const web = ExampleWeb.layerHttp({
  title: "Team tasks",
  accent: "#0f766e",
  ...TeamTasksWebAssets,
})

const services = ExampleIdentity.layer("team-tasks")

pipe(ApplicationBun.run(TeamTasksApplication, {
  database: { migrations: TeamTasksMigrations },
  services,
  admin: true,
  routes: web,
}), BunRuntime.runMain)
