import { Application } from "effect-domains/application"
import { BookResource } from "./resources.ts"

export const BasicCrudApplication = Application.make({
  name: "basic-crud",
  resources: [BookResource],
})
