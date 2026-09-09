import { BunRuntime } from "@effect/platform-bun"
import { SingleRunner } from "effect/unstable/cluster"
import { Layer, pipe } from "effect"
import { ApplicationBun } from "effect-domains/application-bun"
import { ExampleAuthentication } from "@effect-domains/example-support/authentication"
import { OperatorAuthorization } from "./operator-authorization.ts"
import { DurableRemindersApplication } from "./application.ts"
import { ReminderBackground } from "./background.ts"

const manifest = new URL("./migrations/manifest.json", import.meta.url)

const executionDatabase =
  process.env.DURABLE_REMINDERS_EXECUTION_DB
  ?? "durable-reminders.execution.sqlite"


const execution = SingleRunner.layer()
const services = pipe(OperatorAuthorization.layer, Layer.provideMerge(ExampleAuthentication))

pipe(
  ApplicationBun.run(DurableRemindersApplication, {
    database: { manifest },
    execution: {
      database: executionDatabase,
      layer: execution,
    },
    services,
    background: ReminderBackground,
  }),
  BunRuntime.runMain,
)
