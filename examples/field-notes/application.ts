import { Application } from "effect-domains/application"
import { FieldReportsResource } from "./resources.ts"

export const FieldNotesApplication = Application.make({ name: "field-notes", parts: [FieldReportsResource] })
