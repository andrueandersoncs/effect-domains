import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { TeamTasksApplication } from "./application.ts"
import { TeamTasksMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)

const webSite = StaticSpa.site({
  title: "Team tasks",
  accent: "#0f766e",
  base: webBase,
})

const web = StaticSpa.layerHttp(webSite)

const services = ExampleIdentity.layer("team-tasks")

pipe(ApplicationBun.run(TeamTasksApplication, {
  database: { migrations: TeamTasksMigrations },
  services,
  admin: true,
  routes: web,
}), BunRuntime.runMain)
