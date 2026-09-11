import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { CustomerSchema, RepairJobSchema, TechnicianSchema } from "./domain.ts"

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
  operations: {
    ...Resource.crud,
    patch: true,
    create: { defaults: { urgent: false, status: "queued", technicianId: null } },
    list: { filter: ["status", "customerId", "technicianId"] },
  },
  relations: {
    foreignKeys: [
      { name: "repair_jobs_customer", fields: ["customerId"], references: { table: "customers", fields: ["id"] } },
      { name: "repair_jobs_technician", fields: ["technicianId"], references: { table: "technicians", fields: ["id"] } },
    ],
    indexes: [
      { name: "repair_jobs_status", fields: ["status"] },
      { name: "repair_jobs_customer_id", fields: ["customerId"] },
      { name: "repair_jobs_technician_id", fields: ["technicianId"] },
    ],
  },
})
