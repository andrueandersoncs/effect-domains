import { Application } from "effect-domains/application"
import { Counter } from "./counter.ts"
import { CounterCommands } from "./contracts.ts"
import { CounterResource } from "./resources.ts"

export const PersistedRefApplication = Application.make({
  name: "persisted-ref",
  resources: [CounterResource],
  commands: CounterCommands,
})

export const PersistedRefHandlers = PersistedRefApplication.toLayer(Counter)
