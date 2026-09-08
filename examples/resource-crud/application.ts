import { RpcGroup } from "effect/unstable/rpc"
import { Application } from "effect-domains/application"
import { TodosResource } from "./resources.ts"

const commands = RpcGroup.make()

export const ResourceCrudApplication = Application.make({
  name: "resource-crud",
  resources: [TodosResource],
  commands,
})
