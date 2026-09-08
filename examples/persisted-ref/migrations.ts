import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }

export const CounterMigrations = SqliteMigrations.history([initial])
