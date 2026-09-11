import { Application } from "effect-domains/application"

import {
  CustomersResource,
  RepairJobsResource,
  TechniciansResource,
} from "./resources.ts"

import { RepairWorkshopOperations } from "./sqlite.ts"

export const RepairWorkshopApplication = Application.make({
  name: "repair-workshop",
  parts: [
    CustomersResource,
    TechniciansResource,
    RepairJobsResource,
    RepairWorkshopOperations,
  ],
})
