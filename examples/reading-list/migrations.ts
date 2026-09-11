import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import artifact0 from "./migrations/001_initial.json" with { type: "json" }

export const ReadingListMigrations = SqliteMigrations.history(artifact0)
