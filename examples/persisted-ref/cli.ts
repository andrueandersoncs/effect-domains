import { BunRuntime } from "@effect/platform-bun"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import { PersistedRefApplication } from "./application.ts"

const schemaCommand = SqliteMigrations.command({
  name: "schema",
  tables: PersistedRefApplication.tables,
})

const persistedRefCli = ApplicationBun.cli({
  application: PersistedRefApplication,
  schema: schemaCommand,
})

BunRuntime.runMain(persistedRefCli)
