import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { ResourceCrudApplication } from "./application.ts"
import { TodoMigrations } from "./migrations.ts"


pipe(ApplicationBun.run(ResourceCrudApplication, {
  database: { migrations: TodoMigrations },
  services: ExampleAuthentication,
  admin: true,
}), BunRuntime.runMain)
