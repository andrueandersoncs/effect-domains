import { Effect, Schema, pipe } from "effect"
import { SqliteMigration } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }
import documentMetadata from "./migrations/002_document_metadata.json" with { type: "json" }

const SqliteMigrationCodecSchema = Schema.toCodecJson(SqliteMigration)

const MigrationLifecycleMigrationsSchema = Schema.Array(
  SqliteMigrationCodecSchema,
)

export const MigrationLifecycleMigrations = pipe(
  [initial, documentMetadata],
  Schema.decodeUnknownEffect(MigrationLifecycleMigrationsSchema),
  Effect.runSync,
)
