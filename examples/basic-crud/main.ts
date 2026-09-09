import { ApplicationBun } from "effect-domains/application-bun"
import { BasicCrudApplication } from "./application.ts"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

ApplicationBun.runMain(BasicCrudApplication, {
  database: { manifest },
  admin: true,
})
