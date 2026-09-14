import { Application, Part } from "effect-domains/application"
import { AssetsResource } from "./resources.ts"

const parts = [Part.resource(AssetsResource)]
const equipmentRegister = Application.define({ name: "equipment-register", parts })
export const EquipmentRegisterApplication = Application.compile(equipmentRegister)
