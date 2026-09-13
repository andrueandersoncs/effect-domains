import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReadingListApplication } from "./application.ts"
import { ReadingListMigrations } from "./migrations.ts"

const webBase = new URL("./web/", import.meta.url)

const webSite = StaticSpa.site({
  title: "Reading list",
  accent: "#9a3412",
  base: webBase,
})

const web = StaticSpa.layerHttp(webSite)

pipe(ApplicationBun.run(ReadingListApplication, {
  database: { migrations: ReadingListMigrations },
  admin: true,
  routes: web,
  telemetry: {
    resource: {
      serviceName: "reading-list",
      attributes: { "deployment.environment.name": "local" },
    },
  },
}), BunRuntime.runMain)
