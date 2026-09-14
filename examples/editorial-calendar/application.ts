import { Application, Part } from "effect-domains/application"
import { DocumentsResource } from "./resources.ts"

const parts = [Part.resource(DocumentsResource)]
const editorialCalendar = Application.define({ name: "editorial-calendar", parts })
export const EditorialCalendarApplication = Application.compile(editorialCalendar)
