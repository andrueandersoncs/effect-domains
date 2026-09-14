import { Schema } from "effect"
import { ReadModel } from "effect-domains/read-model"
import { CustomersResource, RepairJobsResource, TechniciansResource } from "./resources.ts"

export const RepairBoard = ReadModel.define({
  tables: ReadModel.sources({ job: RepairJobsResource, customer: CustomersResource, technician: TechniciansResource }),
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

export const RepairBoardList = ReadModel.page({
  model: RepairBoard,
  filter: ["status"],
  order: [["urgent", "desc"], ["id", "asc"]],
  limit: 50,
})
export const RepairBoardPage = ReadModel.compilePage(RepairBoardList)


export const RepairBoardRowSchema = Schema.toType(ReadModel.compile(RepairBoard).schema)
