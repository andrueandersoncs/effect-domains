import { Data, Effect, Equivalence, flow, Option, Predicate, Record, Schema, Struct, pipe } from "effect"
import type { Rpc } from "effect/unstable/rpc"
import { RepositoryAccess, RepositoryError, RepositoryStore, ResourceNotFound, UniqueViolation, VersionConflict } from "./repository-store.ts"
import type { TableField } from "./physical-table-field.ts"
import type { Table, TableFieldName } from "./table-relations.ts"
import type { CreationInspection } from "./resource-creation.ts"
import type { RpcBundle } from "./rpc-contract.ts"
import { DomainIdentifier, PageLimitSchema, type StructSchema, type StructValue } from "./domain.ts"
import { Authorization } from "./authorization.ts"

import {
  type AuthorizationAction,
  type AuthorizationDefinition,
  type AuthorizationRuntime,
  Forbidden,
  Unauthenticated,
  type PolicyAuthorization,
  type SubjectOperand,
} from "./authorization-model.ts"

import { EntitlementRequired, EntitlementUnavailable } from "./entitlements.ts"
import type { TransitionMachine } from "./transitions.ts"

const ForbiddenFieldSchema = Schema.optionalKey(Schema.Never)
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)

type ResourceOperation = "get" | "list" | "create" | "update" | "remove" | "patch" | "transition"

type ResourceOperations<S extends StructSchema, Auth> = Readonly<Partial<
  Record<Exclude<ResourceOperation, "create" | "list">, boolean> & {
    list: boolean | ListPolicy<S>
    create: boolean | CreationPolicy<S, Auth>
  }
>>

type CreationFrom<Operations> = Operations extends { readonly create: infer Value }
  ? Value extends true | false ? {} : Value
  : {}

type ListFrom<Operations> = Operations extends { readonly list: infer Value }
  ? Value extends true | false ? {} : Value
  : {}

type EnabledOperation<Operations> = Extract<keyof Operations, ResourceOperation>

type PublishedOperation<Operations> = {
  readonly [Operation in EnabledOperation<Operations>]:
    Operations[Operation] extends false | { readonly publish: false } ? never : Operation
}[EnabledOperation<Operations>]

type PublishedCapabilities<Operations> = Readonly<{
  [Operation in ResourceOperation]: Operation extends PublishedOperation<Operations> ? true : false
}>

type CreationDefaultKeys<Creation> = Creation extends { readonly defaults: infer Defaults }
  ? Extract<keyof Defaults, string> : never

type CreationGeneratedKeys<Creation> = Creation extends { readonly generated: infer Generated }
  ? Extract<keyof Generated, string> : never

type CreationSubjectKeys<Creation> = Creation extends { readonly fromSubject: infer Bindings }
  ? Extract<keyof Bindings, string> : never

type NullableKeys<S extends StructSchema> = {
  readonly [Key in Extract<keyof S["fields"], string>]: null extends S["Type"][Key] ? Key : never
}[Extract<keyof S["fields"], string>]

type SubjectBindings<S extends StructSchema, Auth> =
  Auth extends PolicyAuthorization
    ? Readonly<Partial<{ readonly [Key in Extract<keyof S["fields"], string>]: SubjectOperand<S["Type"][Key]> }>>
    : never

type CreationPolicy<S extends StructSchema, Auth = PolicyAuthorization> = Readonly<Partial<{
  defaults: Partial<Pick<S["Type"], Extract<keyof S["fields"], string>>>
  generated: Partial<Record<Extract<keyof S["fields"], string>, "uuidV7" | "now">>
  fromSubject: SubjectBindings<S, Auth>
  publish: false
}>>

type ListField<S extends StructSchema> = TableFieldName<S>

type ListPolicy<S extends StructSchema> = Readonly<Partial<{
  filter: ReadonlyArray<ListField<S>>
  range: ReadonlyArray<ListField<S>>
  order: ReadonlyArray<readonly [ListField<S>, "asc" | "desc"]>
  limit: number
  publish: false
}>>

const GenerationTokenSchema = Schema.Literals(["uuidV7", "now"])
const CreationInputSchema = Schema.TaggedStruct("Input", {})
const CreationDefaultSchema = Schema.TaggedStruct("Default", { value: Schema.Unknown })
const CreationGeneratedSchema = Schema.TaggedStruct("Generated", { token: GenerationTokenSchema })
const CreationSubjectSchema = Schema.TaggedStruct("Subject", { operand: Schema.Unknown })

const CreationSourceSchema = Schema.Union([
  CreationInputSchema,
  CreationDefaultSchema,
  CreationGeneratedSchema,
  CreationSubjectSchema,
])

type TypedCreationSource<Value, Auth> =
  | Readonly<{ readonly _tag: "Input" }>
  | Readonly<{ readonly _tag: "Default"; readonly value: Value }>
  | Readonly<{ readonly _tag: "Generated"; readonly token: "uuidV7" | "now" }>
  | (Auth extends PolicyAuthorization
    ? Readonly<{ readonly _tag: "Subject"; readonly operand: SubjectOperand<Value> }>
    : never)

type CreationSources<S extends StructSchema, Auth> = Readonly<Partial<{
  readonly [Key in Extract<keyof S["fields"], string>]:
    TypedCreationSource<S["Type"][Key], Auth>
}>>

const creationInput = () => CreationInputSchema.make({})

const creationDefault = <const Value>(value: Value) =>
  Object.freeze({ _tag: "Default" as const, value })

const creationGenerated = <const Token extends "uuidV7" | "now">(token: Token) =>
  Object.freeze({ _tag: "Generated" as const, token })

const creationSubject = <const Value>(operand: SubjectOperand<Value>) =>
  Object.freeze({ _tag: "Subject" as const, operand })

const ListFieldsSchema = Schema.Array(Schema.String)
const ListOrderEntrySchema = Schema.Tuple([Schema.String, Schema.Literals(["asc", "desc"])])
const ListOrderSchema = Schema.Array(ListOrderEntrySchema)
const CreationSourcesSchema = Schema.Record(Schema.String, CreationSourceSchema)
const OptionalListFieldsSchema = Schema.optionalKey(ListFieldsSchema)
const OptionalListOrderSchema = Schema.optionalKey(ListOrderSchema)
const OptionalPageLimitSchema = Schema.optionalKey(PageLimitSchema)
const OptionalPublishSchema = Schema.optionalKey(Schema.Literal(false))
const OptionalCreationSourcesSchema = Schema.optionalKey(CreationSourcesSchema)

const GetCapabilitySchema = Schema.TaggedStruct("Get", {})

const ListCapabilitySchema = Schema.TaggedStruct("List", {
  filter: OptionalListFieldsSchema,
  range: OptionalListFieldsSchema,
  order: OptionalListOrderSchema,
  limit: OptionalPageLimitSchema,
  publish: OptionalPublishSchema,
})

const CreateCapabilitySchema = Schema.TaggedStruct("Create", {
  sources: OptionalCreationSourcesSchema,
  publish: OptionalPublishSchema,
})

const UpdateCapabilitySchema = Schema.TaggedStruct("Update", {})
const RemoveCapabilitySchema = Schema.TaggedStruct("Remove", {})
const PatchCapabilitySchema = Schema.TaggedStruct("Patch", {})
const TransitionCapabilitySchema = Schema.TaggedStruct("Transition", {})

const ResourceCapabilitySchema = Schema.Union([
  GetCapabilitySchema,
  ListCapabilitySchema,
  CreateCapabilitySchema,
  UpdateCapabilitySchema,
  RemoveCapabilitySchema,
  PatchCapabilitySchema,
  TransitionCapabilitySchema,
])

type ResourceCapability = Schema.Schema.Type<typeof ResourceCapabilitySchema>
type CreateCapability = Extract<ResourceCapability, { readonly _tag: "Create" }>

type CreateCapabilityPolicy<
  S extends StructSchema,
  Auth,
  Sources extends CreationSources<S, Auth> = CreationSources<S, Auth>,
> = {
  readonly [Key in keyof CreateCapability]:
    Key extends "sources" ? Sources : CreateCapability[Key]
}

type CapabilityFor<S extends StructSchema, Auth> = ResourceCapability & (
  | Readonly<{ readonly _tag: "Get" | "Update" | "Remove" | "Patch" | "Transition" }>
  | (Readonly<{ readonly _tag: "List" }> & ListPolicy<S>)
  | CreateCapabilityPolicy<S, Auth>
)

const capabilityGet = () => GetCapabilitySchema.make({})
const capabilityUpdate = () => UpdateCapabilitySchema.make({})
const capabilityRemove = () => RemoveCapabilitySchema.make({})
const capabilityPatch = () => PatchCapabilitySchema.make({})
const capabilityTransition = () => TransitionCapabilitySchema.make({})

function capabilityList(): Readonly<{ readonly _tag: "List" }>

function capabilityList<const Policy extends ListPolicy<StructSchema>>(
  policy: Policy,
): Readonly<{ readonly _tag: "List" }> & Policy

function capabilityList(
  policy: ListPolicy<StructSchema> = {},
) {
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  return ListCapabilitySchema.make(policy as never) as
    Readonly<{ readonly _tag: "List" }> & ListPolicy<StructSchema>
}

function capabilityCreate(): Readonly<{ readonly _tag: "Create" }>

function capabilityCreate<const Policy extends Omit<CreateCapability, "_tag">>(
  policy: Policy,
): Readonly<{ readonly _tag: "Create" }> & Policy

function capabilityCreate(
  policy: Omit<CreateCapability, "_tag"> = {},
) {
  return Object.freeze({ _tag: "Create" as const, ...policy })
}

const capabilities = <
  const Values extends ReadonlyArray<ResourceCapability>,
>(...values: Values) => Object.freeze(values)

const crud = () => {
  const get = capabilityGet()
  const list = capabilityList()
  const create = capabilityCreate()
  const update = capabilityUpdate()
  const remove = capabilityRemove()

  return capabilities(get, list, create, update, remove)
}

type ProtectedKeys<Creation, Version extends string | undefined> =
  CreationGeneratedKeys<Creation> | CreationSubjectKeys<Creation> | Extract<Version, string>

type OptionalDraftKeys<S extends StructSchema, Creation, Version extends string | undefined> =
  Extract<CreationDefaultKeys<Creation> | Exclude<NullableKeys<S>, ProtectedKeys<Creation, Version>>, keyof S["Type"]>

type ResourceDraft<S extends StructSchema, Creation, Version extends string | undefined> =
  Omit<S["Type"], OptionalDraftKeys<S, Creation, Version> | ProtectedKeys<Creation, Version>> &
  Partial<Pick<S["Type"], OptionalDraftKeys<S, Creation, Version>>>

/** Versioned writes must state the version they read; unversioned writes take none. */
type ExpectedVersion<Version extends string | undefined> = Version extends string ? readonly [expectedVersion: number] : readonly []

type ResourceChanges<S extends StructSchema, Key extends string, Version extends string | undefined> =
  Partial<Omit<S["Type"], Key | Extract<Version, string>>>

type TransitionChanges<S extends StructSchema, Key extends string, Version extends string | undefined, Transition> =
  Partial<Omit<S["Type"], Key | Extract<Version, string> | Extract<Transition, { readonly field: string }>["field"]>>

type RangeInput<S extends StructSchema, Policy extends ListPolicy<S>> = Policy["range"] extends ReadonlyArray<infer Field>
  ? Partial<{ readonly [Key in Extract<Field, keyof S["Type"]>]: Readonly<Partial<{ from: S["Type"][Key]; to: S["Type"][Key] }>> }>
  : Readonly<Record<string, never>>

type ResourceListRequest<S extends StructSchema, Policy extends ListPolicy<S>> = Readonly<Partial<{
  filter: Policy["filter"] extends ReadonlyArray<infer Field>
    ? Partial<Pick<S["Type"], Extract<Field, keyof S["Type"]>>>
    : Readonly<Record<string, never>>
  range: RangeInput<S, Policy>
  limit: number
  cursor: string
}>>

const ListOperationSchema = Schema.Struct({
  filter: Schema.optionalKey(Schema.Array(Schema.String)),
  range: Schema.optionalKey(Schema.Array(Schema.String)),
  order: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.String, Schema.Literals(["asc", "desc"])]))),
  limit: Schema.optionalKey(PageLimitSchema),
  publish: Schema.optionalKey(Schema.Literal(false)),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

const CreateOperationSchema = Schema.Struct({
  defaults: Schema.optionalKey(UnknownRecordSchema),
  generated: Schema.optionalKey(Schema.Record(Schema.String, Schema.Literals(["uuidV7", "now"]))),
  fromSubject: Schema.optionalKey(UnknownRecordSchema),
  publish: Schema.optionalKey(Schema.Literal(false)),
})

interface CreateOperation extends Schema.Schema.Type<typeof CreateOperationSchema> {}

const OptionalOperationSchema = Schema.optionalKey(Schema.Boolean)
const OptionalListOperationSchema = Schema.optionalKey(Schema.Union([Schema.Boolean, ListOperationSchema]))
const OptionalCreateOperationSchema = Schema.optionalKey(Schema.Union([Schema.Boolean, CreateOperationSchema]))

const OperationsSchema = Schema.Struct({
  get: OptionalOperationSchema,
  list: OptionalListOperationSchema,
  create: OptionalCreateOperationSchema,
  update: OptionalOperationSchema,
  remove: OptionalOperationSchema,
  patch: OptionalOperationSchema,
  transition: OptionalOperationSchema,
}).annotate({ parseOptions: { onExcessProperty: "error" } })

const decodeOperations = Schema.decodeUnknownEffect(OperationsSchema)

type CompatibleStorage<Canonical extends StructSchema, Storage extends StructSchema> =
  Storage["Type"] extends Canonical["Type"] ? Canonical["Type"] extends Storage["Type"] ? unknown : never : never

const ResourceErrorSchema = Schema.Union([RepositoryError, ResourceNotFound, UniqueViolation, Unauthenticated, Forbidden, EntitlementRequired, EntitlementUnavailable])
const PublicResourceErrorSchema = Schema.Union([RepositoryError, ResourceNotFound, UniqueViolation])

type DeclaredResourceError<Auth> = Schema.Schema.Type<
  Auth extends typeof Authorization.public ? typeof PublicResourceErrorSchema : typeof ResourceErrorSchema
> | VersionConflict

/** Public resources never fail with identity errors; policy resources keep them. */
type AuthorizedError<Auth, Error> = unknown extends Error
  ? DeclaredResourceError<Auth>
  : Auth extends typeof Authorization.public
    ? Exclude<Error, Forbidden | Unauthenticated | EntitlementRequired | EntitlementUnavailable>
    : Error

class ResourceDefinitionError extends Schema.TaggedError<ResourceDefinitionError>()(
  "ResourceDefinitionError",
  { resource: Schema.String, reason: Schema.String },
) {}

const invalidInput = (resource: string, _reason: string) =>
  RepositoryError.make({ resource })

const equals = Equivalence.strictEqual<unknown>()
const absentAuthorizationValue = Option.none<StructValue>()

const identityAnnotation = (schema: Schema.Constraint) => {
  const annotations = Schema.resolveAnnotations(schema)

  return equals(annotations?.[DomainIdentifier], true)
}

const fieldNamed = (name: string) => (field: TableField) =>
  equals(field.name, name)

const integerRequired = (field: TableField) => {
  const integer = equals(field.scalar, "integer")
  const required = !field.nullable

  return integer && required
}

/** The candidate row to write and the row the guard expects to find. */
class Replacement extends Data.Class<{
  readonly next: StructValue
  readonly expected: StructValue
}> {}

const decodeVersion = Schema.decodeUnknownEffect(Schema.Int)
const noVersionValue = Option.none<number>()
const noChanges: Readonly<Record<string, never>> = Record.empty()
const noVersion = Effect.succeed(noVersionValue)
const isUniqueViolation = Predicate.isTagged("UniqueViolation")

const sameString = (value: string) => (candidate: string) =>
  equals(candidate, value)

const statusDocument = flow(Schema.toCodecJson, Schema.toJsonSchemaDocument, JSON.stringify)

const canonicalInteger = (schema: Schema.Constraint) => {
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const document = Schema.toJsonSchemaDocument(schema) as { readonly schema: Readonly<Partial<{ readonly type: unknown }>> }

  return equals(document.schema.type, "integer")
}

const withAuthorization = <Auth>(authorization: AuthorizationRuntime, table: Table) =>
  <Args extends ReadonlyArray<unknown>, A, E, R>(
    action: AuthorizationAction,
    use: (store: RepositoryStore["Service"], permission: RepositoryAccess, ...args: Args) => Effect.Effect<A, E, R>,
  ) => {
    const reading = equals(action, "read")

    const authorized = Effect.fn("Repository.withAuthorization")(function* (...args: [...Args]) {
      const subject = yield* authorization.subject(action)
      const store = yield* RepositoryStore
      const permission = new RepositoryAccess({ policy: authorization.visibility, subject })
      const effect = use(store, permission, ...args)

      return yield* (reading ? effect : store.transaction(effect))
    })

    type Failure = Effect.Error<ReturnType<typeof authorized>>

    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    return authorized as (...args: [...Args]) => Effect.Effect<A, AuthorizedError<Auth, Failure>, R | RepositoryStore>
  }

export type Resource = RpcBundle & Readonly<{
  name: string
  schema: StructSchema
  storage: StructSchema
  _tag: "CompiledResource"
  table: Table
  operations: ReadonlyArray<ResourceOperation>
  authorization: AuthorizationDefinition
  creation: CreationInspection
  list: ListPolicy<StructSchema>
  contracts: Readonly<Record<ResourceOperation, Rpc.Any>>
}> & Readonly<Partial<{
  version: string
  transitions: TransitionMachine
}>>

export {
  capabilities,
  capabilityCreate,
  capabilityGet,
  capabilityList,
  capabilityPatch,
  capabilityRemove,
  capabilityTransition,
  capabilityUpdate,
  creationDefault,
  creationGenerated,
  creationInput,
  creationSubject,
  crud,
  absentAuthorizationValue,
  canonicalInteger,
  type CompatibleStorage,
  type CreationFrom,
  type CreationPolicy,
  CreationSourceSchema,
  type CreationSources,
  decodeOperations,
  decodeVersion,
  equals,
  type ExpectedVersion,
  fieldNamed,
  ForbiddenFieldSchema,
  identityAnnotation,
  integerRequired,
  invalidInput,
  isUniqueViolation,
  type ListField,
  type ListFrom,
  type ListPolicy,
  noChanges,
  noVersion,
  noVersionValue,
  type PublishedCapabilities,
  type PublishedOperation,
  PublicResourceErrorSchema,
  sameString,
  Replacement,
  type ResourceCapability,
  type ResourceChanges,
  ResourceDefinitionError,
  ResourceErrorSchema,
  type ResourceListRequest,
  type ResourceOperation,
  type ResourceOperations,
  type ResourceDraft,
  statusDocument,
  type TransitionChanges,
  withAuthorization,
}
