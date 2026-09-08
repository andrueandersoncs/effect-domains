import { BunRuntime } from "@effect/platform-bun"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import { ResourceCrudApplication } from "./application.ts"

const schemaCommand = SqliteMigrations.command({
  name: "schema",
  tables: ResourceCrudApplication.tables,
})

const resourceCrudCli = ApplicationBun.cli({
  application: ResourceCrudApplication,
  schema: schemaCommand,
})

BunRuntime.runMain(resourceCrudCli)
