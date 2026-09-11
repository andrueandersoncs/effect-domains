import { Application } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { TasksResource } from "./resources.ts"

export const TeamTasksApplication = Application.make({ name: "team-tasks", parts: [TasksResource, IdentityBundle] })
