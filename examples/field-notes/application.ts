import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { FieldReportsResource } from "./resources.ts"
import { Effect } from "effect"

const parts = [Part.resource(FieldReportsResource), Part.native(IdentityBundle)]
const fieldNotes = Application.define({ name: "field-notes", parts })
export const FieldNotesApplication = Effect.runSync(Application.compile(fieldNotes))
