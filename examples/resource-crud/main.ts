import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "../authentication.ts"
import { ResourceCrudApplication } from "./application.ts"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

ApplicationBun.runMain(ResourceCrudApplication, {
  database: { manifest },
  services: ExampleAuthentication,
  admin: true,
})
