import { pipe } from "effect"
import * as ApplicationBun from "effect-domains/application-bun"
import { ReadingListInfrastructureIR } from "./infrastructure.ts"

const program = ApplicationBun.runInfrastructure(ReadingListInfrastructureIR, {
  telemetry: {
    resource: {
      serviceName: "reading-list",
      attributes: { "deployment.environment.name": "local" },
    },
  },
})

pipe(program, ApplicationBun.runMain)
