import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { ResourceCrudApplication } from "./application.ts"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

pipe(ApplicationBun.run(ResourceCrudApplication, {
  database: { manifest },
  services: ExampleAuthentication,
  admin: true,
}), BunRuntime.runMain)
