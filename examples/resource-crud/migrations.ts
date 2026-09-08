import { Effect, Schema, pipe } from "effect"
import { SqliteMigration } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }

const SqliteMigrationCodecSchema = Schema.toCodecJson(SqliteMigration)
const TodoMigrationsSchema = Schema.Array(SqliteMigrationCodecSchema)

const decodeTodoMigrations = Schema.decodeUnknownEffect(TodoMigrationsSchema)

export const TodoMigrations = pipe(
  [initial],
  decodeTodoMigrations,
  Effect.runSync,
)
