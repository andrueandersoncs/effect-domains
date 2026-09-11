import { BunRuntime } from "@effect/platform-bun"
import { SingleRunner } from "effect/unstable/cluster"
import { Layer, pipe } from "effect"
import { ExampleWeb } from "@effect-domains/example-web/serve"
import { privateSqlite } from "@effect-domains/example-support/databases"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleIdentity } from "@effect-domains/example-support/identity"
import { AppointmentRemindersApplication } from "./application.ts"
import { AppointmentReminderBackground } from "./background.ts"
import { AppointmentReminderMigrations } from "./migrations.ts"
import { AppointmentRemindersWebAssets } from "./web/assets.ts"

const executionDatabase =
  process.env.APPOINTMENT_REMINDERS_EXECUTION_DB
  ?? "data/appointment-reminders.execution.sqlite"

const executionSql = privateSqlite(executionDatabase)

const execution = pipe(SingleRunner.layer(), Layer.provide(executionSql))
const services = Layer.mergeAll(ExampleIdentity, execution)

const web = ExampleWeb.layerHttp({
  title: "Appointment reminders",
  accent: "#9f1239",
  ...AppointmentRemindersWebAssets,
})

pipe(
  ApplicationBun.run(AppointmentRemindersApplication, {
    database: { migrations: AppointmentReminderMigrations },
    services,
    background: AppointmentReminderBackground,
    routes: web,
  }),
  BunRuntime.runMain,
)
