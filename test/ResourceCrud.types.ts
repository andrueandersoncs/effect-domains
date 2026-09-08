import { Schema } from "effect"
import { identifier } from "../src/domain.ts"
import { Resource } from "../src/resource.ts"

const TypeProbe = Resource.make({
  name: "resource_type_probe",
  schema: Schema.Struct({ title: Schema.NonEmptyString, completed: Schema.Boolean }),
  create: { defaults: { completed: false } },
  list: { filter: ["completed"], order: [{ field: "title" }] },
  operations: [...Resource.crud, "patch"] as const,
})

const NoPolicyProbe = Resource.make({
  name: "resource_no_policy_probe",
  schema: Schema.Struct({ id: identifier(Schema.String), value: Schema.Int }),
  operations: [],
})

const noPolicyCreate: Parameters<typeof NoPolicyProbe.repository.create>[0] = {
  id: "required",
  value: 1,
}

const createInput: Parameters<typeof TypeProbe.repository.create>[0] = { title: "required" }
const pageInput: Parameters<typeof TypeProbe.repository.page>[0] = { filter: { completed: false }, limit: 1 }
const patchInput: Parameters<typeof TypeProbe.repository.patch>[1] = { title: "changed" }

void createInput
void pageInput
void patchInput

void noPolicyCreate

// @ts-expect-error Defaults do not make unrelated canonical fields optional.
const missingTitle: Parameters<typeof TypeProbe.repository.create>[0] = {}
// @ts-expect-error Filters must be explicitly selected in the list declaration.
const undeclaredFilter: Parameters<typeof TypeProbe.repository.page>[0] = { filter: { title: "hidden" } }
// @ts-expect-error The identifier is not a mutable patch field.
const redirectedPatch: Parameters<typeof TypeProbe.repository.patch>[1] = { id: "other" }

const GeneratedProbe = Resource.make({
  name: "generated_type_probe",
  schema: Schema.Struct({
    id: identifier(Schema.String),
    title: Schema.String,
    createdAt: Schema.DateTimeUtc,
  }),
  create: { generated: { id: "uuidV7", createdAt: "now" } },
  operations: Resource.crud,
})
const generatedInput: Parameters<typeof GeneratedProbe.repository.create>[0] = { title: "only authored input" }
// @ts-expect-error Generated fields cannot be provided by callers.
const generatedOverride: Parameters<typeof GeneratedProbe.repository.create>[0] = { id: "override", title: "bad" }
void missingTitle
void undeclaredFilter
void redirectedPatch
void generatedInput
void generatedOverride