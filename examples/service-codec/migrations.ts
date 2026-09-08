import { Effect, Schema, pipe } from "effect"
import { SqliteMigration } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }

const SqliteMigrationCodecSchema = Schema.toCodecJson(SqliteMigration)
const NotesMigrationsSchema = Schema.Array(SqliteMigrationCodecSchema)
const decodeNotesMigrations = Schema.decodeUnknownEffect(NotesMigrationsSchema)

export const NotesMigrations = pipe(
  [initial],
  decodeNotesMigrations,
  Effect.runSync,
)
