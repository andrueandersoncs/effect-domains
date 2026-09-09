import { BunRuntime } from "@effect/platform-bun"
import { pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { BasicCrudApplication } from "./application.ts"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

pipe(ApplicationBun.run(BasicCrudApplication, {
  database: { manifest },
  admin: true,
}), BunRuntime.runMain)
