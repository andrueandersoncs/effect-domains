import { Authorization } from "effect-domains/authorization"
import { type Effect, Schema } from "effect"
import type { Rpc, RpcGroup } from "effect/unstable/rpc"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { Transitions } from "effect-domains/transitions"

const TypeProbeSchema = Schema.Struct({ title: Schema.NonEmptyString, completed: Schema.Boolean })
interface TypeProbe extends Schema.Schema.Type<typeof TypeProbeSchema> {}

const TypeProbe = Resource.make({
  authorization: Authorization.public,
  name: "resource_type_probe",
  schema: TypeProbeSchema,
  operations: {
    ...Resource.crud,
    remove: false,
    patch: true,
    create: { defaults: { completed: false }, publish: false },
    list: { filter: ["completed"], publish: false },
  },
})

const NoPolicyProbeSchema = Schema.Struct({ id: identifier(Schema.String), value: Schema.Int })
interface NoPolicyProbe extends Schema.Schema.Type<typeof NoPolicyProbeSchema> {}
const NoPolicyProbe = Resource.make({ authorization: Authorization.public, name: "resource_no_policy_probe", schema: NoPolicyProbeSchema, operations: {} })

const noPolicyCreate: Parameters<typeof NoPolicyProbe.repository.create>[0] = {
  id: "required",
  value: 1,
}

const createInput: Parameters<typeof TypeProbe.repository.create>[0] = { title: "required" }
const listInput: Parameters<typeof TypeProbe.repository.list>[0] = { filter: { completed: false }, limit: 1 }
const patchInput: Parameters<typeof TypeProbe.repository.patch>[1] = { title: "changed" }

void createInput
void listInput
void patchInput

undefined satisfies Parameters<typeof TypeProbe.repository.list>[0]
const defaultListInput: Parameters<typeof NoPolicyProbe.repository.list>[0] = { limit: 1, cursor: "continuation" }
const listPage: Effect.Success<ReturnType<typeof TypeProbe.repository.list>> = { items: [], nextCursor: null }
const defaultListPage: Effect.Success<ReturnType<typeof NoPolicyProbe.repository.list>> = { items: [], nextCursor: "continuation" }

const contractListInput: typeof TypeProbe.contracts.list.payloadSchema.Type = {
  filter: { completed: true },
  limit: 1,
}

const contractListPage: typeof TypeProbe.contracts.list.successSchema.Type = {
  items: [],
  nextCursor: null,
}

// @ts-expect-error because generated lists never return bare arrays.
const bareList: Effect.Success<ReturnType<typeof NoPolicyProbe.repository.list>> = []
void defaultListInput
void listPage
void defaultListPage
void contractListInput
void contractListPage
void bareList

void noPolicyCreate

// @ts-expect-error because defaults do not make unrelated canonical fields optional.
const missingTitle: Parameters<typeof TypeProbe.repository.create>[0] = {}
// @ts-expect-error because filters must be explicitly selected in the list declaration.
const undeclaredFilter: Parameters<typeof TypeProbe.repository.list>[0] = { filter: { title: "hidden" } }
// @ts-expect-error because default lists do not declare any filters.
const undeclaredDefaultFilter: Parameters<typeof NoPolicyProbe.repository.list>[0] = { filter: { value: 1 } }
// @ts-expect-error because the identifier is not a mutable patch field.
const redirectedPatch: Parameters<typeof TypeProbe.repository.patch>[1] = { id: "other" }

const GeneratedProbeSchema = Schema.Struct({
  id: identifier(Schema.String),
  title: Schema.String,
  createdAt: Schema.DateTimeUtc,
})

interface GeneratedProbe extends Schema.Schema.Type<typeof GeneratedProbeSchema> {}
const GeneratedProbe = Resource.make({ authorization: Authorization.public, name: "generated_type_probe", schema: GeneratedProbeSchema, operations: { ...Resource.crud, create: { generated: { id: "uuidV7", createdAt: "now" } } } })
const generatedInput: Parameters<typeof GeneratedProbe.repository.create>[0] = { title: "only authored input" }
// @ts-expect-error because generated fields cannot be provided by callers.
const generatedOverride: Parameters<typeof GeneratedProbe.repository.create>[0] = { id: "override", title: "bad" }
void missingTitle
void undeclaredFilter
void undeclaredDefaultFilter
void redirectedPatch
void generatedInput
void generatedOverride

type PublishedPatch = Extract<RpcGroup.Rpcs<typeof TypeProbe.group>, { readonly _tag: "resource_type_probe.patch" }>
const publishedPatch: Rpc.Payload<PublishedPatch> = { key: "row", changes: { title: "changed" } }

type UnpublishedCreate = Extract<RpcGroup.Rpcs<typeof TypeProbe.group>, { readonly _tag: "resource_type_probe.create" }>
type UnpublishedList = Extract<RpcGroup.Rpcs<typeof TypeProbe.group>, { readonly _tag: "resource_type_probe.list" }>
type UnpublishedRemove = Extract<RpcGroup.Rpcs<typeof TypeProbe.group>, { readonly _tag: "resource_type_probe.remove" }>
type IsNever<Value> = [Value] extends [never] ? true : false
const unpublishedOperations: readonly [IsNever<UnpublishedCreate>, IsNever<UnpublishedList>, IsNever<UnpublishedRemove>] = [true, true, true]
void unpublishedOperations
// @ts-expect-error because patch identity has its own envelope field.
const missingPatchKey: Rpc.Payload<PublishedPatch> = { changes: { title: "changed" } }
// @ts-expect-error because canonical identifiers remain immutable inside changes.
const changedPatchKey: Rpc.Payload<PublishedPatch> = { key: "row", changes: { id: "other" } }
void publishedPatch
void missingPatchKey
void changedPatchKey

const VersionedTypeProbeSchema = Schema.Struct({
  id: identifier(Schema.String),
  title: Schema.String,
  summary: Schema.NullOr(Schema.String),
  version: Schema.Int,
})

const VersionedTypeProbe = Resource.make({
  authorization: Authorization.public,
  name: "versioned_type_probe",
  schema: VersionedTypeProbeSchema,
  version: "version",
  operations: { create: true, patch: true },
})

const nullableCreate: Parameters<typeof VersionedTypeProbe.repository.create>[0] = { id: "row", title: "required" }
const versionedPatch: Parameters<typeof VersionedTypeProbe.repository.patch> = ["row", { title: "changed" }, 1]
void nullableCreate
void versionedPatch
// @ts-expect-error because version is framework-managed on create.
const suppliedVersion: Parameters<typeof VersionedTypeProbe.repository.create>[0] = { id: "row", title: "bad", version: 1 }
// @ts-expect-error because versioned patches require their expected version.
const missingExpectedVersion: Parameters<typeof VersionedTypeProbe.repository.patch> = ["row", { title: "changed" }]
// @ts-expect-error because version may not be changed through patch fields.
const patchedVersion: Parameters<typeof VersionedTypeProbe.repository.patch> = ["row", { version: 2 }, 1]
void suppliedVersion
void missingExpectedVersion
void patchedVersion

const NullableGeneratedProbeSchema = Schema.Struct({
  id: identifier(Schema.String),
  note: Schema.NullOr(Schema.DateTimeUtc),
})

const NullableGeneratedProbe = Resource.make({
  authorization: Authorization.public,
  name: "nullable_generated_probe",
  schema: NullableGeneratedProbeSchema,
  operations: { create: { generated: { note: "now" } } },
})

// @ts-expect-error because a nullable generated field remains protected from create input.
const generatedNullableOverride: Parameters<typeof NullableGeneratedProbe.repository.create>[0] = { id: "row", note: null }
void generatedNullableOverride

const TransitionStatusSchema = Schema.Literals(["held", "confirmed"])

const TypeTransitions = Transitions.make({
  name: "TypeReservation",
  field: "status",
  status: TransitionStatusSchema,
  transitions: { confirm: { from: ["held"], to: "confirmed" } },
})

const TransitionTypeProbeSchema = Schema.Struct({ id: identifier(Schema.String), status: TransitionStatusSchema, version: Schema.Int })

const TransitionTypeProbe = Resource.make({
  authorization: Authorization.public,
  name: "transition_type_probe",
  schema: TransitionTypeProbeSchema,
  version: "version",
  transitions: TypeTransitions,
  operations: { transition: true },
})

TypeTransitions.field satisfies "status"
const appliedTransition = TypeTransitions.apply("confirm", "key")({ status: "held" })
type AppliedTransition = Effect.Success<typeof appliedTransition>
const transitionTarget = "confirmed" satisfies AppliedTransition["status"]
void transitionTarget
type PublishedTransition = Extract<RpcGroup.Rpcs<typeof TransitionTypeProbe.group>, { readonly _tag: "transition_type_probe.transition" }>
const transitionPayload: Rpc.Payload<PublishedTransition> = { key: "row", action: "confirm", expectedVersion: 1 }
void transitionPayload
