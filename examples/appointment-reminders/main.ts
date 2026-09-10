import { BunRuntime } from "@effect/platform-bun"
import { SingleRunner } from "effect/unstable/cluster"
import { Layer, pipe } from "effect"
import { privateSqlite } from "@effect-domains/example-support/databases"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { AppointmentRemindersApplication } from "./application.ts"
import { AppointmentReminderBackground } from "./background.ts"
import { AppointmentReminderMigrations } from "./migrations.ts"

const executionDatabase =
  process.env.APPOINTMENT_REMINDERS_EXECUTION_DB
  ?? "appointment-reminders.execution.sqlite"

const executionSql = privateSqlite(executionDatabase)

const execution = pipe(SingleRunner.layer(), Layer.provide(executionSql))
const services = Layer.mergeAll(ExampleAuthentication, execution)

pipe(
  ApplicationBun.run(AppointmentRemindersApplication, {
    database: { migrations: AppointmentReminderMigrations },
    services,
    background: AppointmentReminderBackground,
  }),
  BunRuntime.runMain,
)
