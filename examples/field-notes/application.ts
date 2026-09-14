import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { FieldReportsResource } from "./resources.ts"

export const FieldNotesApplication = Application.compile(Application.define({ name: "field-notes", parts: [Part.resource(FieldReportsResource), Part.native(IdentityBundle)] }))
