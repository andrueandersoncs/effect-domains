import { Application } from "effect-domains/application"
import { TasksResource } from "./resources.ts"

export const TeamTasksApplication = Application.make({ name: "team-tasks", parts: [TasksResource] })
