import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import artifact0 from "./migrations/001_initial.json" with { type: "json" }

export const AppointmentReminderMigrations = SqliteMigrations.history(artifact0)
