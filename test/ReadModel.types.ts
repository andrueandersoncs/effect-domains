import { Schema, type Types } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { identifier } from "effect-domains/domain"
import { ReadModel } from "effect-domains/read-model"
import { Table } from "effect-domains/table"
import { StoragePrefix, StoredTextSchema } from "./prefix-codec.ts"

const JobSchema = Schema.Struct({ urgent: Schema.Boolean, technicianId: Schema.NullOr(Schema.String) })
const TechnicianSchema = Schema.Struct({ id: identifier(Schema.String), name: StoredTextSchema })
const Jobs = Table.make({ name: "jobs", schema: JobSchema })
const Technicians = Table.make({ name: "technicians", schema: TechnicianSchema })

const model = ReadModel.define({
  tables: ReadModel.sources({ j: Jobs, t: Technicians }),
  from: "j",
  joins: [{ kind: "left", table: "t", on: [{ left: ["j", "technicianId"], right: ["t", "id"] }] }],
  select: { urgent: ["j", "urgent"], name: ["t", "name"] },
})
const view = ReadModel.compile(model)

const row: typeof view.schema.Type = { urgent: true, name: null }
// @ts-expect-error because projections decode booleans, not SQLite bits.
const badBoolean: typeof view.schema.Type = { urgent: 1, name: "Sam" }
// @ts-expect-error because only left-joined fields become nullable.
const badNull: typeof view.schema.Type = { urgent: null, name: "Sam" }
// @ts-expect-error because a projected record contains exactly the selected fields.
const unselected: typeof view.schema.Type = { urgent: true, name: null, technicianId: "sam" }
const decoderService = true satisfies Types.Equals<typeof view.schema.DecodingServices, StoragePrefix>
const encoderService = true satisfies Types.Equals<typeof view.schema.EncodingServices, StoragePrefix>
const noService = ReadModel.compile(ReadModel.define({
  tables: ReadModel.sources({ t: Technicians }),
  from: "t",
  joins: [],
  select: { id: ["t", "id"] },
}))
const omittedService = true satisfies Types.Equals<typeof noService.schema.DecodingServices, never>
const nonnullable = true satisfies Types.Equals<typeof noService.schema.Type, { readonly id: string }>

const listing = ReadModel.compilePage(ReadModel.page({
  model,
  filter: ["urgent"],
  order: [["urgent", "desc"]],
}))
const listInput: typeof listing.payload.Type = { filter: { urgent: true }, limit: 10 }
// @ts-expect-error because only declared filters are accepted.
const invalidFilter: typeof listing.payload.Type = { filter: { name: "Sam" } }

ReadModel.page({
  model,
  // @ts-expect-error because list ordering must use selected output fields.
  order: [["missing", "asc"]],
})

declare const sql: SqlClient.SqlClient
// @ts-expect-error because fields must exist in the selected table.
view.column(sql, ["j", "missing"])
// @ts-expect-error because aliases are declared, not arbitrary SQL strings.
view.column(sql, ["absent", "name"])

ReadModel.define({ tables: ReadModel.sources({ j: Jobs }), from: "j", joins: [], select: {
  // @ts-expect-error because projections must reference existing fields.
  invalid: ["j", "name"],
} })

ReadModel.define({ tables: ReadModel.sources({ j: Jobs }),
  // @ts-expect-error because FROM must reference a declared alias.
  from: "unknown", joins: [], select: { urgent: ["j", "urgent"] },
})

void row
void badBoolean
void badNull
void unselected
void decoderService
void encoderService
void omittedService
void nonnullable
void listInput
void invalidFilter
