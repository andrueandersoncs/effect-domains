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

export const RepairWorkshopApplication = Effect.runSync(Application.compile(repairWorkshop))
