import { Application } from "effect-domains/application"
import { TodosResource } from "./resources.ts"

export const ResourceCrudApplication = Application.make({ name: "resource-crud", parts: [TodosResource] })
