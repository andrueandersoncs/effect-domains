import { BunRuntime } from "@effect/platform-bun"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { EditorialCalendarApplication } from "./application.ts"
import { EditorialCalendarMigrations } from "./migrations.ts"
import { EditorialCalendarWebAssets } from "./web/assets.ts"

const web = ExampleWeb.layerHttp({
  title: "Editorial calendar",
  accent: "#6d28d9",
  ...EditorialCalendarWebAssets,
})

pipe(ApplicationBun.run(EditorialCalendarApplication, {
  database: { migrations: EditorialCalendarMigrations },
  admin: true,
  routes: web,
}), BunRuntime.runMain)
