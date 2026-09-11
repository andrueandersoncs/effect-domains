import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { CustomerSchema, RepairJobSchema, RepairJobTransitions, TechnicianSchema } from "./domain.ts"

export const CustomersResource = Resource.make({
  name: "customers",
  schema: CustomerSchema,
  authorization: Authorization.public,
  operations: { ...Resource.crud, patch: true },
})

export const TechniciansResource = Resource.make({
  name: "technicians",
  schema: TechnicianSchema,
  authorization: Authorization.public,
  operations: { ...Resource.crud, patch: true },
})

export const RepairJobsResource = Resource.make({
  name: "repair_jobs",
  schema: RepairJobSchema,
  authorization: Authorization.public,
  transitions: RepairJobTransitions,
  operations: {
    ...Resource.crud,
    patch: true,
    transition: true,
    create: { defaults: { urgent: false, status: "queued" } },
    list: {
      filter: ["status", "customerId", "technicianId"],
      order: [["urgent", "desc"]],
    },
  },
  relations: {
    foreignKeys: [
      { fields: ["customerId"], references: { table: "customers", fields: ["id"] } },
      { fields: ["technicianId"], references: { table: "technicians", fields: ["id"] } },
    ],
    indexes: [
      { fields: ["status"] },
      { fields: ["customerId"] },
      { fields: ["technicianId"] },
    ],
  },
})
