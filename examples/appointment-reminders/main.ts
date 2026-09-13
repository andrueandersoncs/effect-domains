import { BunRuntime } from "@effect/platform-bun"
import { SingleRunner } from "effect/unstable/cluster"
import { Layer, pipe } from "effect"
import { StaticSpa } from "effect-domains/static-spa"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { AppointmentRemindersApplication } from "./application.ts"
import { AppointmentReminderBackground } from "./background.ts"
import { AppointmentReminderMigrations } from "./migrations.ts"

const privateClient = SqliteBunRuntime.privateClient({
  application: "appointment-reminders",
  purpose: "execution",
})

const execution = pipe(
  SingleRunner.layer(),
  Layer.provide(privateClient),
)

const webBase = new URL("./web/", import.meta.url)

const webSite = StaticSpa.site({
  title: "Appointment reminders",
  accent: "#9f1239",
  base: webBase,
})

const web = StaticSpa.layerHttp(webSite)

const identity = ExampleIdentity.layer("appointment-reminders")
const services = Layer.mergeAll(identity, execution)

pipe(ApplicationBun.run(AppointmentRemindersApplication, {
  database: { migrations: AppointmentReminderMigrations },
  services,
  background: AppointmentReminderBackground,
  routes: web,
}), BunRuntime.runMain)
