import { Authorization } from "effect-domains/authorization"
import { Schema } from "effect"
import type { Rpc, RpcGroup } from "effect/unstable/rpc"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"

const TypeProbeSchema = Schema.Struct({ title: Schema.NonEmptyString, completed: Schema.Boolean })
interface TypeProbe extends Schema.Schema.Type<typeof TypeProbeSchema> {}
const TypeProbe = Resource.make({ authorization: Authorization.public, name: "resource_type_probe", schema: TypeProbeSchema, create: { defaults: { completed: false } }, list: { filter: ["completed"], order: [{ field: "title" }] }, operations: [...Resource.crud, "patch"] as const })
const NoPolicyProbeSchema = Schema.Struct({ id: identifier(Schema.String), value: Schema.Int })
interface NoPolicyProbe extends Schema.Schema.Type<typeof NoPolicyProbeSchema> {}
const NoPolicyProbe = Resource.make({ authorization: Authorization.public, name: "resource_no_policy_probe", schema: NoPolicyProbeSchema, operations: [] })

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

// @ts-expect-error because defaults do not make unrelated canonical fields optional.
const missingTitle: Parameters<typeof TypeProbe.repository.create>[0] = {}
// @ts-expect-error because filters must be explicitly selected in the list declaration.
const undeclaredFilter: Parameters<typeof TypeProbe.repository.page>[0] = { filter: { title: "hidden" } }
// @ts-expect-error because the identifier is not a mutable patch field.
const redirectedPatch: Parameters<typeof TypeProbe.repository.patch>[1] = { id: "other" }

const GeneratedProbeSchema = Schema.Struct({
  id: identifier(Schema.String),
  title: Schema.String,
  createdAt: Schema.DateTimeUtc,
})

interface GeneratedProbe extends Schema.Schema.Type<typeof GeneratedProbeSchema> {}
const GeneratedProbe = Resource.make({ authorization: Authorization.public, name: "generated_type_probe", schema: GeneratedProbeSchema, create: { generated: { id: "uuidV7", createdAt: "now" } }, operations: Resource.crud })
const generatedInput: Parameters<typeof GeneratedProbe.repository.create>[0] = { title: "only authored input" }
// @ts-expect-error because generated fields cannot be provided by callers.
const generatedOverride: Parameters<typeof GeneratedProbe.repository.create>[0] = { id: "override", title: "bad" }
void missingTitle
void undeclaredFilter
void redirectedPatch
void generatedInput
void generatedOverride

type PublishedPatch = Extract<RpcGroup.Rpcs<typeof TypeProbe.group>, { readonly _tag: "resource_type_probe.patch" }>
const publishedPatch: Rpc.Payload<PublishedPatch> = { key: "row", changes: { title: "changed" } }
// @ts-expect-error because patch identity has its own envelope field.
const missingPatchKey: Rpc.Payload<PublishedPatch> = { changes: { title: "changed" } }
// @ts-expect-error because canonical identifiers remain immutable inside changes.
const changedPatchKey: Rpc.Payload<PublishedPatch> = { key: "row", changes: { id: "other" } }
void publishedPatch
void missingPatchKey
void changedPatchKey
