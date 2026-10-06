import { Schema } from "effect"
import { Resource } from "effect-domains/resource"
import { TallySchema } from "./domain.ts"
import { CandidatesResource, ElectionsResource } from "./resources.ts"

const electionsTable = Resource.table(ElectionsResource)
const candidatesTable = Resource.table(CandidatesResource)

export const SlateSchema = Schema.Struct({
  election: electionsTable.rowSchema,
  candidates: Schema.Array(candidatesTable.rowSchema),
})

interface Slate extends Schema.Schema.Type<typeof SlateSchema> {}

export const ElectionResultSchema = Schema.Struct({
  ...SlateSchema.fields,
  tally: TallySchema,
})

interface ElectionResult extends Schema.Schema.Type<typeof ElectionResultSchema> {}
