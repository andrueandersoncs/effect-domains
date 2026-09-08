import { Effect, Schema, pipe } from "effect"
import { SqliteMigration } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }

const SqliteMigrationCodecSchema = Schema.toCodecJson(SqliteMigration)
const CounterMigrationsSchema = Schema.Array(SqliteMigrationCodecSchema)

const decodeCounterMigrations = Schema.decodeUnknownEffect(
  CounterMigrationsSchema,
)

export const CounterMigrations = pipe(
  [initial],
  decodeCounterMigrations,
  Effect.runSync,
)
