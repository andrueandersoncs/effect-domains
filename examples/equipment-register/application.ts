import { Application, Part } from "effect-domains/application"
import { AssetsResource } from "./resources.ts"

export const EquipmentRegisterApplication = Application.compile(Application.define({ name: "equipment-register", parts: [Part.resource(AssetsResource)] }))
