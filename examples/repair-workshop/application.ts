import { Application } from "effect-domains/application"
import { RepairWorkshopRpcs } from "./contracts.ts"
import { CustomersResource, RepairJobsResource, TechniciansResource } from "./resources.ts"
import { RepairWorkshopSqlite } from "./sqlite.ts"

export const RepairWorkshopApplication = Application.make({
  name: "repair-workshop",
  parts: [CustomersResource, TechniciansResource, RepairJobsResource, { group: RepairWorkshopRpcs, handlers: RepairWorkshopSqlite }],
})
