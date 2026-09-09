import { BunRuntime } from "@effect/platform-bun"
import { Layer, pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { BillingApplication } from "./application.ts"
import { BillingSqlite } from "./sqlite.ts"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

const services = Layer.merge(BillingSqlite, ExampleAuthentication)

pipe(
  ApplicationBun.run(BillingApplication, {
    database: { manifest },
    services,
    admin: true,
  }),
  BunRuntime.runMain,
)
