import { Application } from "effect-domains/application"
import { DurableWorkflowCommands } from "./workflow.ts"

export const DurableWorkflowsApplication = Application.make({ name: "durable-workflows", parts: [DurableWorkflowCommands] })
