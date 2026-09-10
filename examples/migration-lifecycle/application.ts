import { Application } from "effect-domains/application"
import { DocumentsResource } from "./resources.ts"

export const MigrationLifecycleApplication = Application.make({ name: "migration-lifecycle", parts: [DocumentsResource] })
