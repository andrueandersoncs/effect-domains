import { Effect, pipe } from "effect"
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import artifact0 from "./migrations/001_initial.json" with { type: "json" }

export const ExpenseLedgerMigrations = pipe([artifact0], SqliteMigrations.decodeHistory, Effect.runSync)
