import { Effect, pipe } from "effect"
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }
import timestamp from "./migrations/002_timestamp.json" with { type: "json" }

const rawHistory = [initial, timestamp]

export const InventoryMigrations = pipe(
  rawHistory,
  SqliteMigrations.decodeHistory,
  Effect.runSync,
)
