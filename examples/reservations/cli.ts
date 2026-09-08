import { BunRuntime } from "@effect/platform-bun"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import { ReservationApplication } from "./application.ts"

const schemaCommand = SqliteMigrations.command({
  name: "schema",
  tables: ReservationApplication.tables,
})

const reservationCli = ApplicationBun.cli({
  application: ReservationApplication,
  schema: schemaCommand,
})

BunRuntime.runMain(reservationCli)
