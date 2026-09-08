import { BunRuntime } from "@effect/platform-bun"
import { ApplicationBun } from "effect-domains/application-bun"
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import { NotesApplication } from "./application.ts"

const schemaCommand = SqliteMigrations.command({
  name: "schema",
  tables: NotesApplication.tables,
})

const notesCli = ApplicationBun.cli({
  application: NotesApplication,
  schema: schemaCommand,
})

BunRuntime.runMain(notesCli)
