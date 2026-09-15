import { clusterRuntimeLayer, clusterWorkerLayer } from "@effect-domains/example-support/cluster-runtime"
import { Layer, pipe } from "effect"
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
  clusterRuntimeLayer("appointment-reminders", 1),
  Layer.provide(privateClient),
)


const identity = ExampleIdentity.layer("appointment-reminders")
const services = Layer.mergeAll(identity, execution)
const background = clusterWorkerLayer(AppointmentReminderBackground)

const program = ApplicationBun.run(AppointmentRemindersApplication, {
  database: { migrations: AppointmentReminderMigrations },
  services,
  background,
  ui: {
    presentation: {
      title: "Appointment reminders",
      description: "Schedule durable in-app reminders, then inspect delivery through the generated application interface.",
    },
  },
})

pipe(program, ApplicationBun.runMain)
