import { BunRuntime } from "@effect/platform-bun"
import { SingleRunner } from "effect/unstable/cluster"
import { Context, Effect, Layer, pipe } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { assertDistinctDatabases } from "@effect-domains/example-support/databases"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { AppointmentReminderOperatorAuthorization } from "./operator-authorization.ts"
import { AppointmentRemindersApplication } from "./application.ts"
import { AppointmentReminderBackground } from "./background.ts"
import { AppointmentReminderMigrations } from "./migrations.ts"

const executionDatabase =
  process.env.APPOINTMENT_REMINDERS_EXECUTION_DB
  ?? "appointment-reminders.execution.sqlite"

const executionSql = pipe(Effect.gen(function* () {
  const applicationSql = yield* SqlClient.SqlClient

  const verifyDatabase = (context: Context.Context<SqlClient.SqlClient>) => {
    const executionSql = Context.get(context, SqlClient.SqlClient)
    return assertDistinctDatabases(applicationSql, executionSql)
  }

  return pipe(
    SqliteClient.layer({ filename: executionDatabase }),
    Layer.tap(verifyDatabase),
  )
}), Layer.unwrap)

const execution = pipe(SingleRunner.layer(), Layer.provide(executionSql))
const authentication = pipe(AppointmentReminderOperatorAuthorization.layer, Layer.provideMerge(ExampleAuthentication))
const services = Layer.mergeAll(authentication, execution)

pipe(
  ApplicationBun.run(AppointmentRemindersApplication, {
    database: { migrations: AppointmentReminderMigrations },
    services,
    background: AppointmentReminderBackground,
  }),
  BunRuntime.runMain,
)
