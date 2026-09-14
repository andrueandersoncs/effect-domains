import { Application, Part } from "effect-domains/application"
import { ReadingListResource } from "./resources.ts"

export const ReadingListApplication = Application.compile(Application.define({
  name: "reading-list",
  parts: [Part.resource(ReadingListResource)],
}))
