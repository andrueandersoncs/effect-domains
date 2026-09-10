import { Application } from "effect-domains/application"
import { DocumentsResource } from "./resources.ts"

export const EditorialCalendarApplication = Application.make({ name: "editorial-calendar", parts: [DocumentsResource] })
