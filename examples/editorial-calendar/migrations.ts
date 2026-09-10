import { Effect, pipe } from "effect"
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }
import documentMetadata from "./migrations/002_document_metadata.json" with { type: "json" }
import schemaStringChecks from "./migrations/003_schema_string_checks.json" with { type: "json" }
import editorialMetadata from "./migrations/004_editorial_metadata.json" with { type: "json" }

const rawHistory = [initial, documentMetadata, schemaStringChecks, editorialMetadata]

export const EditorialCalendarMigrations = pipe(
  rawHistory,
  SqliteMigrations.decodeHistory,
  Effect.runSync,
)
