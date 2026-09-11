import { SqliteMigrations } from "effect-domains/sqlite-migrations"
import assetRegister from "./migrations/001_initial.json" with { type: "json" }

export const EquipmentRegisterMigrations = SqliteMigrations.history(assetRegister)
