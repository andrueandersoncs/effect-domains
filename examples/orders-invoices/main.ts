import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { BillingApplication } from "./application.ts"
import { BillingMigrations } from "./migrations.ts"


pipe(
  ApplicationBun.run(BillingApplication, {
    database: { migrations: BillingMigrations },
    services: ExampleAuthentication,
    admin: true,
  }),
  BunRuntime.runMain,
)
