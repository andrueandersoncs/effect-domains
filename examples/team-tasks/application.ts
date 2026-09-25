import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { TasksResource } from "./resources.ts"
import { TaskReview } from "./review.ts"
import { Effect } from "effect"

const parts = [Part.resource(TasksResource), Part.command(TaskReview), Part.native(IdentityBundle)]
const teamTasks = Application.define({ name: "team-tasks", parts })
const teamTasksCompiler = Application.compile(teamTasks)
const teamTasksApplication = Effect.runSync(teamTasksCompiler)

export { teamTasksApplication as TeamTasksApplication }
