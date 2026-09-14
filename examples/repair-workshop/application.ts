import { Application, Part } from "effect-domains/application"

import {
  CustomersResource,
  RepairJobsResource,
  TechniciansResource,
} from "./resources.ts"

import { RepairWorkshopOperations } from "./sqlite.ts"

export const RepairWorkshopApplication = Application.compile(Application.define({
  name: "repair-workshop",
  parts: [
    Part.resource(CustomersResource),
    Part.resource(TechniciansResource),
    Part.resource(RepairJobsResource),
    Part.command(RepairWorkshopOperations),
  ],
}))
