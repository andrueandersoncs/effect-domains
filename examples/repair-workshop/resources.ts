import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { Table } from "effect-domains/table"
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

const CustomerIdReference = Table.reference(CustomersResource.table, ["id"])
const TechnicianIdReference = Table.reference(TechniciansResource.table, ["id"])

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
      { fields: ["customerId"], references: CustomerIdReference },
      { fields: ["technicianId"], references: TechnicianIdReference },
    ],
    indexes: [
      { fields: ["status"] },
      { fields: ["customerId"] },
      { fields: ["technicianId"] },
    ],
  },
})
