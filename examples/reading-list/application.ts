import { Application, Part } from "effect-domains/application"
import { ReadingListResource } from "./resources.ts"
import { Effect } from "effect"

const parts = [Part.resource(ReadingListResource)]
const readingList = Application.define({ name: "reading-list", parts })
export const ReadingListApplication = Effect.runSync(Application.compile(readingList))
