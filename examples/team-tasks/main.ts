import { BunRuntime } from "@effect/platform-bun"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { TeamTasksApplication } from "./application.ts"
import { TeamTasksMigrations } from "./migrations.ts"
import { TeamTasksWebAssets } from "./web/assets.ts"

const web = ExampleWeb.layerHttp({
  title: "Team tasks",
  accent: "#0f766e",
  ...TeamTasksWebAssets,
})

pipe(ApplicationBun.run(TeamTasksApplication, {
  database: { migrations: TeamTasksMigrations },
  services: ExampleAuthentication,
  admin: true,
  routes: web,
}), BunRuntime.runMain)
