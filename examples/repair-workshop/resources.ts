import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { CustomerSchema, RepairJobSchema, RepairJobTransitions, TechnicianSchema } from "./domain.ts"

const mutableResourceCapabilities = [...Resource.crud(), Resource.patch()]

export const CustomersResource = Resource.define({
  name: "customers",
  schema: CustomerSchema,
  authorization: Authorization.public,
  capabilities: mutableResourceCapabilities,
})

export const TechniciansResource = Resource.define({
  name: "technicians",
  schema: TechnicianSchema,
  authorization: Authorization.public,
  capabilities: mutableResourceCapabilities,
})

const CustomerIdReference = Resource.reference(CustomersResource, ["id"])
const TechnicianIdReference = Resource.reference(TechniciansResource, ["id"])

const repairJobCreateSources = {
  urgent: Resource.default(false),
  status: Resource.default("queued"),
}

const repairJobCapabilities = [
  Resource.get(),
  Resource.list({
    filter: ["status", "customerId", "technicianId"],
    order: [["urgent", "desc"]],
  }),
  Resource.create({ sources: repairJobCreateSources }),
  Resource.update(),
  Resource.remove(),
  Resource.patch(),
  Resource.transition(),
]

export const RepairJobsResource = Resource.define({
  name: "repair_jobs",
  schema: RepairJobSchema,
  authorization: Authorization.public,
  transitions: RepairJobTransitions,
  capabilities: repairJobCapabilities,
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
