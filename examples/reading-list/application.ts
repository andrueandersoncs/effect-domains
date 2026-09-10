import { Application } from "effect-domains/application"
import { ReadingListResource } from "./resources.ts"

export const ReadingListApplication = Application.make({
  name: "reading-list",
  parts: [ReadingListResource],
})
