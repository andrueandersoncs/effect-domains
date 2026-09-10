import { Effect, pipe } from "effect"
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import artifact0 from "./migrations/001_initial.json" with { type: "json" }
import artifact1 from "./migrations/002_ownership.json" with { type: "json" }
import artifact2 from "./migrations/003_schema_string_checks.json" with { type: "json" }
import artifact3 from "./migrations/004_task_details.json" with { type: "json" }

export const TeamTasksMigrations = pipe(
  [artifact0, artifact1, artifact2, artifact3],
  SqliteMigrations.decodeHistory,
  Effect.runSync,
)
