import { Effect, Schema, pipe } from "effect"
import { SqliteMigration } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }

const SqliteMigrationCodecSchema = Schema.toCodecJson(SqliteMigration)
const BasicCrudMigrationsSchema = Schema.Array(SqliteMigrationCodecSchema)

const decodeBasicCrudMigrations = Schema.decodeUnknownEffect(
  BasicCrudMigrationsSchema,
)

export const BasicCrudMigrations = pipe(
  [initial],
  decodeBasicCrudMigrations,
  Effect.runSync,
)
