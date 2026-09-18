import { FlyInfrastructure } from "@effect-domains/alchemy/fly"
import { Effect } from "effect"

import { ReadingListInfrastructureIR } from "./infrastructure.ts"

const deployment = FlyInfrastructure.make({
  infrastructure: ReadingListInfrastructureIR,
  options: {
    main: import.meta.url,
    handler: "Runtime",
  },
})

export const Runtime = Effect.fn("ReadingListFly.Runtime")(function* () {
  return yield* deployment.runtime
})()

export default deployment.stack
