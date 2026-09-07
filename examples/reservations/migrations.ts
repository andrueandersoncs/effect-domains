import { Effect, Schema, pipe } from "effect"
import { SqliteMigration } from "../../src/sqlite-migrations.ts"
import initial from "./migrations/001_initial.json" with { type: "json" }
import timestamp from "./migrations/002_timestamp.json" with { type: "json" }

const SqliteMigrationCodecSchema = Schema.toCodecJson(SqliteMigration)
const InventoryMigrationsSchema = Schema.Array(SqliteMigrationCodecSchema)

const decodeInventoryMigrations = Schema.decodeUnknownEffect(
  InventoryMigrationsSchema,
)


export const InventoryMigrations = pipe(
  [initial, timestamp],
  decodeInventoryMigrations,
  Effect.runSync,
)
