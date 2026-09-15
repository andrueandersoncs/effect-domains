import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }
import executionOutbox from "./migrations/002_execution_outbox.json" with { type: "json" }
import audit from "./migrations/003_audit.json" with { type: "json" }

export const ReportExportMigrations = SqliteMigrations.history(initial, executionOutbox, audit)
