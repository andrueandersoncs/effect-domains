import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }
import timestamp from "./migrations/002_timestamp.json" with { type: "json" }

export const InventoryMigrations = SqliteMigrations.history([initial, timestamp])
