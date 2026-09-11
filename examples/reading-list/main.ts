import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { ApplicationBun } from "effect-domains/application-bun"
import { ReadingListApplication } from "./application.ts"
import { ReadingListMigrations } from "./migrations.ts"
import { ReadingListWebAssets } from "./web/assets.ts"

const web = ExampleWeb.layerHttp({
  title: "Reading list",
  accent: "#9a3412",
  ...ReadingListWebAssets,
})

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
