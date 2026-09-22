import { Application, Part } from "effect-domains/application"

import {
  CustomersResource,
  RepairJobsResource,
  TechniciansResource,
} from "./resources.ts"

import { RepairWorkshopOperations } from "./sqlite.ts"
import { Effect } from "effect"

const parts = [
  Part.resource(CustomersResource),
  Part.resource(TechniciansResource),
  Part.resource(RepairJobsResource),
  Part.command(RepairWorkshopOperations),
]

const repairWorkshop = Application.define({ name: "repair-workshop", parts })

const repairWorkshopCompiler = Application.compile(repairWorkshop)
const repairWorkshopApplication = Effect.runSync(repairWorkshopCompiler)

export { repairWorkshopApplication as RepairWorkshopApplication }
