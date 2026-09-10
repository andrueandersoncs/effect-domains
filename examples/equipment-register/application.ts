import { Application } from "effect-domains/application"
import { AssetsResource } from "./resources.ts"

export const EquipmentRegisterApplication = Application.make({ name: "equipment-register", parts: [AssetsResource] })
