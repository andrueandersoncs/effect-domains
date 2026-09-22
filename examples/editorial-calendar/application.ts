import { Application, Part } from "effect-domains/application"
import { DocumentsResource } from "./resources.ts"
import { Effect } from "effect"

const parts = [Part.resource(DocumentsResource)]
const editorialCalendar = Application.define({ name: "editorial-calendar", parts })
const editorialCalendarCompiler = Application.compile(editorialCalendar)
const editorialCalendarApplication = Effect.runSync(editorialCalendarCompiler)

export { editorialCalendarApplication as EditorialCalendarApplication }
