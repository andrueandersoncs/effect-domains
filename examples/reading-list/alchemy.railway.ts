import { RailwayInfrastructure } from "@effect-domains/alchemy/railway"
import { Effect } from "effect"

import { ReadingListInfrastructureIR } from "./infrastructure.ts"

const deployment = RailwayInfrastructure.make({
  infrastructure: ReadingListInfrastructureIR,
  options: {
    main: import.meta.url,
    handler: "Runtime",
  },
})

export const Runtime = Effect.fn("ReadingListRailway.Runtime")(function* () {
  return yield* deployment.runtime
})()

export default deployment.stack
