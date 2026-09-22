import { Application, Part } from "effect-domains/application"
import { AssetsResource } from "./resources.ts"
import { Effect } from "effect"

const parts = [Part.resource(AssetsResource)]
const equipmentRegister = Application.define({ name: "equipment-register", parts })
const equipmentRegisterCompiler = Application.compile(equipmentRegister)
const equipmentRegisterApplication = Effect.runSync(equipmentRegisterCompiler)

export { equipmentRegisterApplication as EquipmentRegisterApplication }
