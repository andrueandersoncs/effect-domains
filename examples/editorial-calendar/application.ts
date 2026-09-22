import { Application, Part } from "effect-domains/application"
import { DocumentsResource } from "./resources.ts"
import { Effect } from "effect"

const parts = [Part.resource(DocumentsResource)]
const editorialCalendar = Application.define({ name: "editorial-calendar", parts })
export const EditorialCalendarApplication = Effect.runSync(Application.compile(editorialCalendar))
