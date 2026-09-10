import { Effect, pipe } from "effect"
import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import initial from "./migrations/001_initial.json" with { type: "json" }

export const PurchasedGuidesMigrations = pipe([initial], SqliteMigrations.decodeHistory, Effect.runSync)
