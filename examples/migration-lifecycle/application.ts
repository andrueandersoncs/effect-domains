import { RpcGroup } from "effect/unstable/rpc"
import { Application } from "effect-domains/application"
import { DocumentsResource } from "./resources.ts"

const commands = RpcGroup.make()

export const MigrationLifecycleApplication = Application.make({
  name: "migration-lifecycle",
  resources: [DocumentsResource],
  commands,
})
