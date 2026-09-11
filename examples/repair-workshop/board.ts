import { Schema } from "effect"
import { SqliteView } from "effect-domains/sqlite-view"
import { CustomersResource, RepairJobsResource, TechniciansResource } from "./resources.ts"

export const RepairBoard = SqliteView.make({
  tables: { job: RepairJobsResource.table, customer: CustomersResource.table, technician: TechniciansResource.table },
  from: "job",
  joins: [
    { kind: "inner", table: "customer", on: [{ left: ["job", "customerId"], right: ["customer", "id"] }] },
    { kind: "left", table: "technician", on: [{ left: ["job", "technicianId"], right: ["technician", "id"] }] },
  ],
  select: {
    id: ["job", "id"],
    customerId: ["job", "customerId"],
    customerName: ["customer", "name"],
    item: ["job", "item"],
    fault: ["job", "fault"],
    urgent: ["job", "urgent"],
    status: ["job", "status"],
    technicianId: ["job", "technicianId"],
    technicianName: ["technician", "name"],
    technicianOnCall: ["technician", "onCall"],
  },
})

export const RepairBoardRowSchema = Schema.toType(RepairBoard.schema)
