import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { ApplicationBun } from "effect-domains/application-bun"
import { EquipmentRegisterApplication } from "./application.ts"
import { EquipmentRegisterMigrations } from "./migrations.ts"
import { EquipmentRegisterWebAssets } from "./web/assets.ts"

const web = ExampleWeb.layerHttp({
  title: "Equipment register",
  accent: "#334155",
  ...EquipmentRegisterWebAssets,
})

pipe(ApplicationBun.run(EquipmentRegisterApplication, {
  database: { migrations: EquipmentRegisterMigrations },
  routes: web,
}), BunRuntime.runMain)
