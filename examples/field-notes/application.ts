import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { FieldReportsResource } from "./resources.ts"

const parts = [Part.resource(FieldReportsResource), Part.native(IdentityBundle)]
const fieldNotes = Application.define({ name: "field-notes", parts })
export const FieldNotesApplication = Application.compile(fieldNotes)
