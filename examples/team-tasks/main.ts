import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { TeamTasksApplication } from "./application.ts"
import { TeamTasksMigrations } from "./migrations.ts"


pipe(ApplicationBun.run(TeamTasksApplication, {
  database: { migrations: TeamTasksMigrations },
  services: ExampleAuthentication,
  admin: true,
}), BunRuntime.runMain)
