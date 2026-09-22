import { Application, Part } from "effect-domains/application"
import { AssetsResource } from "./resources.ts"
import { Effect } from "effect"

const parts = [Part.resource(AssetsResource)]
const equipmentRegister = Application.define({ name: "equipment-register", parts })
export const EquipmentRegisterApplication = Effect.runSync(Application.compile(equipmentRegister))
