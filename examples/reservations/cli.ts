import { BunRuntime } from "@effect/platform-bun"
import { ApplicationBun } from "../../src/application-bun.ts"
import { SqliteMigrations } from "../../src/sqlite-migrations.ts"
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
