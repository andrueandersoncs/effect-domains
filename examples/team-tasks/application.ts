import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { TasksResource } from "./resources.ts"

export const TeamTasksApplication = Application.compile(Application.define({ name: "team-tasks", parts: [Part.resource(TasksResource), Part.native(IdentityBundle)] }))
