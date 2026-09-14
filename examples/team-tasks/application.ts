import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { TasksResource } from "./resources.ts"

const parts = [Part.resource(TasksResource), Part.native(IdentityBundle)]
const teamTasks = Application.define({ name: "team-tasks", parts })
export const TeamTasksApplication = Application.compile(teamTasks)
