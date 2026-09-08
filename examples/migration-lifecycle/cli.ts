import { BunRuntime } from "@effect/platform-bun"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import { MigrationLifecycleApplication } from "./application.ts"

const schemaCommand = SqliteMigrations.command({
  name: "schema",
  tables: MigrationLifecycleApplication.tables,
})

const migrationLifecycleCli = ApplicationBun.cli({
  application: MigrationLifecycleApplication,
  schema: schemaCommand,
})

BunRuntime.runMain(migrationLifecycleCli)
