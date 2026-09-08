import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }
import documentMetadata from "./migrations/002_document_metadata.json" with { type: "json" }

export const MigrationLifecycleMigrations = SqliteMigrations.history([
  initial,
  documentMetadata,
])
