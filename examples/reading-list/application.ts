import { Application, Part } from "effect-domains/application"
import { ReadingListResource } from "./resources.ts"

const parts = [Part.resource(ReadingListResource)]
const readingList = Application.define({ name: "reading-list", parts })
export const ReadingListApplication = Application.compile(readingList)
