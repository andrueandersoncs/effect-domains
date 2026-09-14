import { Application, Part } from "effect-domains/application"
import { DocumentsResource } from "./resources.ts"

export const EditorialCalendarApplication = Application.compile(Application.define({ name: "editorial-calendar", parts: [Part.resource(DocumentsResource)] }))
