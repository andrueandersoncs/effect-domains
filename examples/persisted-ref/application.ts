import { Application } from "effect-domains/application"
import { CounterCommands } from "./contracts.ts"
import { CounterResource } from "./resources.ts"

export const PersistedRefApplication = Application.make({
  name: "persisted-ref",
  resources: [CounterResource],
  commands: [CounterCommands],
})
