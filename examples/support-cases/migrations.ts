import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }
import audit from "./migrations/002_audit.json" with { type: "json" }

export const SupportCasesMigrations = SqliteMigrations.history(initial, audit)
