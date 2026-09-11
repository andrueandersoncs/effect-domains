import { Application } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { FieldReportsResource } from "./resources.ts"

export const FieldNotesApplication = Application.make({ name: "field-notes", parts: [FieldReportsResource, IdentityBundle] })
