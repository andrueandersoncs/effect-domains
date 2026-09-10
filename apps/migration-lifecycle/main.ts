import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { MigrationLifecycleApplication } from "./application.ts"
import { MigrationLifecycleMigrations } from "./migrations.ts"


pipe(ApplicationBun.run(MigrationLifecycleApplication, {
  database: { migrations: MigrationLifecycleMigrations },
  admin: true,
}), BunRuntime.runMain)
