import { Array, Data, Effect, Equivalence, flow, Function, Layer, Match, Option, Order, Predicate, Record, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { RepositoryAccess, RepositoryError, RepositoryOrder, RepositorySelect, RepositoryStore, ResourceNotFound, UniqueViolation, VersionConflict } from "./repository-store.ts"
import { Table, type TableField, type TableFieldName, type TableRelationsInput, withImplicitIdentifier } from "./table.ts"
import { Creation, type CreationInspection } from "./resource-creation.ts"
import type { RpcBundle } from "./rpc-contract.ts"
import { DomainIdentifier, PageLimitSchema, type StructSchema } from "./domain.ts"
import { Page } from "./page.ts"
import { Authorization, AuthorizationValues, Forbidden, Unauthenticated, type AuthorizationAction, type AuthorizationDefinition, type AuthorizationRuntime, type PolicyAuthorization, type SubjectOperand } from "./authorization.ts"
import { SqliteList } from "./sqlite-list.ts"
import { EntitlementRequired, EntitlementUnavailable } from "./entitlements.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
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

const CreationSourceSchema = Schema.TaggedUnion({
  Input: {},
  Default: { value: Schema.Unknown },
  Generated: { token: Schema.Literals(["uuidV7", "now"]) },
  Subject: { operand: Schema.Unknown },
})

export type CreationSource = Schema.Schema.Type<typeof CreationSourceSchema>

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

type CreateCapabilityPolicy<
  S extends StructSchema,
  Auth,
  Sources extends CreationSources<S, Auth> = CreationSources<S, Auth>,
> = Readonly<{
  sources?: Sources
  publish?: false
}>

const creationInput = () => CreationSourceSchema.cases.Input.make({})
const creationDefault = <const Value>(value: Value) =>
  CreationSourceSchema.cases.Default.make({ value }) as unknown as
    Readonly<{ readonly _tag: "Default"; readonly value: Value }>
const creationGenerated = <const Token extends "uuidV7" | "now">(token: Token) =>
  CreationSourceSchema.cases.Generated.make({ token }) as unknown as
    Readonly<{ readonly _tag: "Generated"; readonly token: Token }>
const creationSubject = <const Value>(operand: SubjectOperand<Value>) =>
  CreationSourceSchema.cases.Subject.make({ operand }) as unknown as
    Readonly<{ readonly _tag: "Subject"; readonly operand: SubjectOperand<Value> }>

const ResourceCapabilitySchema = Schema.TaggedUnion({
  Get: {},
  List: {
    filter: Schema.optionalKey(Schema.Array(Schema.String)),
    range: Schema.optionalKey(Schema.Array(Schema.String)),
    order: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.String, Schema.Literals(["asc", "desc"])]))),
    limit: Schema.optionalKey(PageLimitSchema),
    publish: Schema.optionalKey(Schema.Literal(false)),
  },
  Create: {
    sources: Schema.optionalKey(Schema.Record(Schema.String, CreationSourceSchema)),
    publish: Schema.optionalKey(Schema.Literal(false)),
  },
  Update: {},
  Remove: {},
  Patch: {},
  Transition: {},
})

export type ResourceCapability = Schema.Schema.Type<typeof ResourceCapabilitySchema>

type CapabilityFor<S extends StructSchema, Auth> = ResourceCapability & (
  | Readonly<{ readonly _tag: "Get" | "Update" | "Remove" | "Patch" | "Transition" }>
  | (Readonly<{ readonly _tag: "List" }> & ListPolicy<S>)
  | (Readonly<{ readonly _tag: "Create" }> & CreateCapabilityPolicy<S, Auth>)
)

const capabilityGet = () => ResourceCapabilitySchema.cases.Get.make({})
const capabilityUpdate = () => ResourceCapabilitySchema.cases.Update.make({})
const capabilityRemove = () => ResourceCapabilitySchema.cases.Remove.make({})
const capabilityPatch = () => ResourceCapabilitySchema.cases.Patch.make({})
const capabilityTransition = () => ResourceCapabilitySchema.cases.Transition.make({})

function capabilityList(): Readonly<{ readonly _tag: "List" }>
function capabilityList<const Policy extends ListPolicy<StructSchema>>(
  policy: Policy,
): Readonly<{ readonly _tag: "List" }> & Policy
function capabilityList(
  policy: ListPolicy<StructSchema> = {},
): Readonly<{ readonly _tag: "List" }> & ListPolicy<StructSchema> {
  return ResourceCapabilitySchema.cases.List.make(policy as never) as
    Readonly<{ readonly _tag: "List" }> & ListPolicy<StructSchema>
}

function capabilityCreate(): Readonly<{ readonly _tag: "Create" }>
function capabilityCreate<
  const Policy extends Readonly<{
    sources?: Readonly<Record<string, CreationSource>>
    publish?: false
  }>,
>(policy: Policy): Readonly<{ readonly _tag: "Create" }> & Policy
function capabilityCreate(
  policy: Readonly<{
    sources?: Readonly<Record<string, CreationSource>>
    publish?: false
  }> = {},
): Readonly<{ readonly _tag: "Create" }> & typeof policy {
  return ResourceCapabilitySchema.cases.Create.make(policy as never) as unknown as
    Readonly<{ readonly _tag: "Create" }> & typeof policy
}

const capabilities = <
  const Values extends ReadonlyArray<ResourceCapability>,
>(...values: Values) => Object.freeze([...values]) as Values

const crud = () => capabilities(
  capabilityGet(),
  capabilityList(),
  capabilityCreate(),
  capabilityUpdate(),
  capabilityRemove(),
)

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

type TransitionField<Transition> = Transition extends { readonly field: infer Field extends string } ? Field : never

type TransitionChanges<S extends StructSchema, Key extends string, Version extends string | undefined, Transition> =
  Partial<Omit<S["Type"], Key | Extract<Version, string> | TransitionField<Transition>>>

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
type ResourceErrors<Auth> = Auth extends typeof Authorization.public ? typeof PublicResourceErrorSchema : typeof ResourceErrorSchema

/** Public resources never fail with identity errors; policy resources keep them. */
type AuthorizedError<Auth, Error> = Auth extends typeof Authorization.public
  ? Exclude<Error, Forbidden | Unauthenticated | EntitlementRequired | EntitlementUnavailable>
  : Error

class ResourceDefinitionError extends Schema.TaggedError<ResourceDefinitionError>()(
  "ResourceDefinitionError",
  { resource: Schema.String, reason: Schema.String },
) {}

const invalidInput = (resource: string, reason: string) => {
  const cause = ResourceDefinitionError.make({ resource, reason })
  return RepositoryError.make({ resource, cause })
}

const equals = Equivalence.strictEqual<unknown>()
const absentAuthorizationValue = Option.none<Readonly<Record<string, unknown>>>()

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
  readonly next: Readonly<Record<string, unknown>>
  readonly expected: Readonly<Record<string, unknown>>
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

const compileResource = <
  const Name extends string,
  const S extends StructSchema,
  const Storage extends StructSchema = S,
  const Auth extends AuthorizationDefinition = AuthorizationDefinition,
  const Operations extends ResourceOperations<S, Auth> = ResourceOperations<S, Auth>,
  const Version extends Extract<keyof S["fields"], string> | undefined = undefined,
  const Transition extends TransitionMachine | undefined = undefined,
>(options: Readonly<{ name: Name; schema: S; operations: Operations; authorization: Auth }> & Readonly<Partial<{
  storage: Storage
  relations: TableRelationsInput<TableFieldName<Storage>>
  version: Version
  transitions: Transition
}>> & CompatibleStorage<S, Storage>) => {
    type Creation = CreationFrom<Operations>
    type List = Extract<ListFrom<Operations>, ListPolicy<S>>
    type CanonicalTable = ReturnType<typeof Table.make<Name, S>>
    type CanonicalRow = CanonicalTable["rowSchema"]["Type"]
    type CanonicalKey = CanonicalTable["identifier"]
    type CanonicalId = CanonicalTable["identifierSchema"]["Type"]
    const definitionFailure = (reason: string) => ResourceDefinitionError.make({ resource: options.name, reason })
    const inputFailure = (reason: string) => invalidInput(options.name, reason)
    const operationFailure = flow(Struct.get<Schema.SchemaError, "message">("message"), definitionFailure)

    const operationValues = pipe(
      decodeOperations(options.operations),
      Effect.mapError(operationFailure),
      Effect.runSync,
    )

    const operations = pipe(operationValues, Struct.keys, Array.filter((operation: ResourceOperation): operation is PublishedOperation<Operations> => {
      const value = options.operations[operation]
      const publication = Predicate.isBoolean(value) ? value : value?.publish
      return !equals(publication, false)
    }))

    const isPublished = (operation: ResourceOperation) => Array.contains(operations, operation)
    const publishesGet = isPublished("get")
    const publishesList = isPublished("list")
    const publishesCreate = isPublished("create")
    const publishesUpdate = isPublished("update")
    const publishesRemove = isPublished("remove")
    const publishesPatch = isPublished("patch")
    const publishesTransition = isPublished("transition")

    const published = Object.freeze({
      get: publishesGet,
      list: publishesList,
      create: publishesCreate,
      update: publishesUpdate,
      remove: publishesRemove,
      patch: publishesPatch,
      transition: publishesTransition,
    }) as PublishedCapabilities<Operations>

    const creation = pipe(Option.fromNullishOr(options.operations.create), Option.filter(Predicate.isObject)) as Option.Option<CreationPolicy<S, Auth>>
    const listConfiguration = pipe(Option.fromNullishOr(options.operations.list), Option.filter(Predicate.isObject)) as Option.Option<ListPolicy<S>>
    const createPolicy = Option.getOrUndefined(creation)
    const declaredListPolicy = Option.getOrUndefined(listConfiguration)
    const storageSchema = options.storage ?? options.schema



    const table = Table.make<Name, S | Storage>({
      name: options.name,
      schema: storageSchema,
      relations: options.relations as TableRelationsInput<TableFieldName<S | Storage>>,
    })

    const canonicalNames = pipe(options.schema.fields, Record.keys, Array.sort(Order.String))
    const storageNames = pipe(storageSchema.fields, Record.keys, Array.sort(Order.String))
    const filterFields: ReadonlyArray<string> = declaredListPolicy?.filter ?? []
    const rangeFields: ReadonlyArray<string> = declaredListPolicy?.range ?? []
    const declaredOrder = declaredListPolicy?.order ?? []
    const maximum = declaredListPolicy?.limit ?? 50
    const versionOption = Option.fromNullishOr(options.version)
    const transitionOption = Option.fromNullishOr(options.transitions)
    const version = Option.getOrUndefined(versionOption)
    const transition = Option.getOrUndefined(transitionOption)
    const declaredDefaults: Readonly<Record<string, unknown>> = createPolicy?.defaults ?? Record.empty()
    const declaredGenerated: Readonly<Record<string, "uuidV7" | "now" | "one">> = createPolicy?.generated ?? Record.empty()
    const subjectBindings: Readonly<Record<string, SubjectOperand<unknown>>> = createPolicy?.fromSubject ?? Record.empty()



    const isImplicitDefault = (field: TableField) => {
      const notIdentifier = !equals(field.name, table.identifier)
      return field.nullable && notIdentifier
    }

    const lacksConfiguredValue = (field: TableField) => {
      const defaulted = Record.has(declaredDefaults, field.name)
      const generated = Record.has(declaredGenerated, field.name)
      const subjectBound = Record.has(subjectBindings, field.name)
      const generatedOrDefaulted = defaulted || generated
      const configured = generatedOrDefaulted || subjectBound
      return !configured
    }

    const defaultEntry = (field: TableField) => [field.name, null] as const
    const implicitDefaultFields = pipe(table.fields, Array.filter(isImplicitDefault), Array.filter(lacksConfiguredValue))
    const implicitDefaults = pipe(implicitDefaultFields, Array.map(defaultEntry), Record.fromEntries)
    const defaults = Struct.assign(implicitDefaults, declaredDefaults)

    const versionGenerated = Predicate.isUndefined(version)
      ? declaredGenerated
      : Record.set(declaredGenerated, version, "one" as const)



    const listPolicy: ListPolicy<S> = new Data.Class({
      filter: filterFields as ReadonlyArray<ListField<S>>,
      range: rangeFields as ReadonlyArray<ListField<S>>,
      order: declaredOrder as ReadonlyArray<readonly [ListField<S>, "asc" | "desc"]>,
      limit: maximum,
    })


    const validateDefinition = Effect.gen(function* () {
      const sameFields = Equivalence.Array(Equivalence.strictEqual<string>())(canonicalNames, storageNames)
      if (!sameFields) return yield* definitionFailure("storage fields must match the canonical schema")

      yield* Effect.forEach(canonicalNames, (field) => {
        const canonicalIdentity = pipe(Record.get(options.schema.fields, field), Option.map(identityAnnotation))
        const storageIdentity = pipe(Record.get(storageSchema.fields, field), Option.map(identityAnnotation))
        const equal = Option.makeEquivalence(Equivalence.strictEqual<boolean>())(canonicalIdentity, storageIdentity)
        return equal ? Effect.void : definitionFailure(`storage must preserve canonical identity on ${field}`)
      }, { discard: true })

      yield* pipe(
        Authorization.validateSubjectBindings(options.authorization, options.schema, subjectBindings),
        Effect.mapError(({ reason }) => definitionFailure(reason)),
      )


      const validateKnown = (kind: string, fields: ReadonlyArray<string>) => Effect.forEach(fields, (field) => {
        const canonical = Record.has(options.schema.fields, field)
        const physical = Array.some(table.fields, fieldNamed(field))
        const valid = canonical && physical
        return valid ? Effect.void : definitionFailure(`declares unknown list ${kind} ${field}`)
      }, { discard: true })

      const orderFields = Array.map(declaredOrder, ([field]) => field)
      yield* validateKnown("filter", filterFields)
      yield* validateKnown("range", rangeFields)
      yield* validateKnown("order", orderFields)


      const validRange = (field: string) =>
        table.columns[field as keyof typeof table.columns].orderable


      const validateRange = (field: string) => validRange(field)
        ? Effect.void
        : definitionFailure(`list range ${field} must be orderable`)

      yield* Effect.forEach(rangeFields, validateRange, { discard: true })

      const nullableOrderField = (field: string) => (candidate: TableField): boolean => {
        const sameField = equals(candidate.name, field)
        return sameField && candidate.nullable
      }


      yield* Effect.forEach(declaredOrder, ([field]) => {
        const column = table.columns[field as keyof typeof table.columns]
        const nullable = Array.some(table.fields, nullableOrderField(field))
        const unorderable = !column.orderable
        const unsupported = unorderable || nullable
        return unsupported ? definitionFailure(`list order ${field} must be orderable and non-nullable`) : Effect.void
      }, { discard: true })

      const orderNames = Array.map(declaredOrder, ([field]) => field)

      const duplicateOrder = Array.some(orderNames, (field, index) => {
        const previous = Array.take(orderNames, index)
        return Array.some(previous, sameString(field))
      })

      if (duplicateOrder) return yield* definitionFailure("list order must not repeat a field")
      const identifierPosition = Array.findFirstIndex(orderNames, sameString(table.identifier))

      const misplacedIdentifier = Option.match(identifierPosition, {
        onNone: Function.constant(false),
        onSome: (position) => !equals(position, orderNames.length - 1),
      })


      yield* Option.match(versionOption, {
        onNone: Function.constant(Effect.void),
        onSome: Effect.fn("Repository.validateVersion")(function* (fieldName: string) {
          const field = Array.findFirst(table.fields, fieldNamed(fieldName))
          const canonical = Record.get(options.schema.fields, fieldName)
          const validField = Option.exists(field, integerRequired)
          const validCanonical = Option.exists(canonical, canonicalInteger)
          const mutable = !equals(fieldName, table.identifier)
          const requirements = [validField, validCanonical, mutable]
          const valid = Array.every(requirements, Boolean)
          if (!valid) return yield* definitionFailure(`version ${fieldName} must be a non-nullable integer field`)
        }),
      })

      yield* Option.match(transitionOption, {
        onNone: Function.constant(Effect.void),
        onSome: Effect.fn("Repository.validateTransition")(function* (definition) {
          const resourceStatus = Record.get(options.schema.fields, definition.field)
          const expectedStatus = statusDocument(definition.status)

          const matching = Option.exists(resourceStatus, (status) => {
            const actualStatus = statusDocument(status)
            return equals(actualStatus, expectedStatus)
          })

          if (!matching) return yield* definitionFailure(`transition status field ${definition.field} must have the identical literal schema`)
        }),
      })

      const requiresTransition = Boolean(options.operations.transition)
      const hasTransition = Option.isSome(transitionOption)
      if (!requiresTransition) return
      if (!hasTransition) return yield* definitionFailure("transition operation requires transitions")
    })

    Effect.runSync(validateDefinition)

    const implicitIdentifier = !Record.has(options.schema.fields, table.identifier)
    const canonicalRowSchema = (implicitIdentifier ? withImplicitIdentifier(options.schema) : options.schema) as Schema.Codec<CanonicalRow, unknown, S["DecodingServices"], S["EncodingServices"]>
    const canonicalIdentifierSchema = pipe(Record.get(options.schema.fields, table.identifier), Option.getOrElse(() => table.identifierSchema))
    const authorization = pipe(Authorization.compile({ authorization: options.authorization, resource: options.schema, storage: storageSchema, table }), Effect.runSync)



    const authorize = (
      action: AuthorizationAction,
      subject: Readonly<Record<string, unknown>>,
      row: AuthorizationValues["row"],
      next: AuthorizationValues["next"] = absentAuthorizationValue,
    ) => {
      const values = new AuthorizationValues({ row, next })

      return pipe(
        authorization.check(action, subject, values),
        Effect.catchTag("PolicyEvaluationError", () => RepositoryError.make({ resource: table.name, cause: "Authorization evaluation failed" })),
      )
    }

    const repositoryFailure = (cause: Schema.SchemaError) => RepositoryError.make({ resource: table.name, cause })
    const isCanonical = Schema.is(canonicalRowSchema)
    const canonicalFailure = inputFailure("value does not satisfy the canonical schema")
    const validateCanonical = (value: unknown) => isCanonical(value) ? Effect.succeed(value) : Effect.fail(canonicalFailure)
    const encodeKey = flow(Schema.encodeUnknownEffect(table.identifierStorageSchema), Effect.mapError(repositoryFailure))
    const encodeStorage = flow(Schema.encodeUnknownEffect(table.storageSchema), Effect.mapError(repositoryFailure))
    const encodeRow = flow(validateCanonical, Effect.flatMap(encodeStorage))
    const decodeRow = flow(Schema.decodeUnknownEffect(table.storageSchema), Effect.mapError(repositoryFailure), Effect.flatMap(validateCanonical))
    const missing = (key: unknown) => ResourceNotFound.make({ resource: table.name, key: String(key) })
    const withAccess = withAuthorization<Auth>(authorization, table)



    const readable = Effect.fn("Repository.readable")(function* (subject: RepositoryAccess["subject"], stored: unknown) {
      const result = yield* decodeRow(stored)
      const row = Option.some(result)
      yield* authorize("read", subject, row)
      return result
    })

    const creationSchema = implicitIdentifier ? withImplicitIdentifier(options.schema) : options.schema
    const generatedIdentifier = implicitIdentifier ? Option.some(table.identifier) : Option.none<string>()
    const creationPlan = pipe(Creation.compile(creationSchema.fields, defaults, versionGenerated, subjectBindings, definitionFailure, inputFailure, generatedIdentifier), Effect.runSync)



    const createAuthorized = Effect.fn("Repository.create")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, input: ResourceDraft<S, Creation, Version>,
    ) {
      const complete = yield* creationPlan.materialize(input, permission.subject)
      const encoded = yield* encodeRow(complete)
      const next = Option.some(complete)
      yield* authorize("create", permission.subject, absentAuthorizationValue, next)
      const stored = yield* store.insert(table, encoded)
      return yield* readable(permission.subject, stored)
    })

    const identifierOrder = new RepositoryOrder({ field: table.identifier, direction: "asc" as const })


    const selectKey = Effect.fn("Repository.selectKey")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, key: unknown,
    ) {
      const filter = Record.singleton(table.identifier, key)
      const range = Record.empty()
      const after = Option.none()
      const query = new RepositorySelect({ filter, range, order: [identifierOrder], after, limit: 1 })
      const rows = yield* store.select(table, query, permission)
      return Array.head(rows)
    })


    const findAuthorized = Effect.fn("Repository.find")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, key: CanonicalId,
    ) {
      const encoded = yield* encodeKey(key)
      const stored = yield* selectKey(store, permission, encoded)
      if (Option.isNone(stored)) return Option.none<CanonicalRow>()
      return yield* pipe(readable(permission.subject, stored.value), Effect.map(Option.some))
    })

    const getAuthorized = Effect.fn("Repository.get")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, key: CanonicalId,
    ) {
      const found = yield* findAuthorized(store, permission, key)
      if (Option.isNone(found)) return yield* missing(key)
      return found.value
    })


    const replaceExisting = Effect.fn("Repository.replaceExisting")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, action: Extract<AuthorizationAction, "update" | "patch">,
      key: unknown, changes: Readonly<Record<string, unknown>>, expectedVersion: Option.Option<number> = Option.none(), guard: Readonly<Record<string, unknown>> = Record.empty(),
    ) {
      const encodedKey = yield* encodeKey(key)
      const stored = yield* selectKey(store, permission, encodedKey)
      if (Option.isNone(stored)) return yield* missing(key)
      const current = yield* decodeRow(stored.value)
      const candidate = equals(action, "patch") ? Struct.assign(current, changes) : changes
      const versionField = Option.fromNullishOr(version)

      const versioned = Option.match(versionField, {
        onNone: () => new Replacement({ next: candidate, expected: current }),
        onSome: (field) => {
          const expectedValue = Option.getOrThrow(expectedVersion)
          const next = Struct.assign(candidate, { [field]: expectedValue + 1 })
          const expected = Struct.assign(current, { [field]: expectedValue })
          return new Replacement({ next, expected })
        },
      })

      const encodedExpected = yield* encodeRow(versioned.expected)
      const encoded = yield* encodeRow(versioned.next)

      const versionGuard = Option.match(versionField, {
        onNone: Record.empty,
        onSome: (field) => Record.singleton(field, encodedExpected[field]),
      })

      const currentValue = Option.some(current)
      const nextValue = Option.some(versioned.next)
      const updateGuard = Struct.assign(guard, versionGuard)
      yield* authorize(action, permission.subject, currentValue, nextValue)
      const updated = yield* store.update(table, encoded, permission, updateGuard)
      if (Option.isSome(updated)) return yield* readable(permission.subject, updated.value)

      return yield* Option.match(versionField, {
        onNone: () => missing(key),
        onSome: () => {
          const expectedValue = Option.getOrThrow(expectedVersion)
          return VersionConflict.make({ resource: table.name, key: String(key), expectedVersion: expectedValue })
        },
      })


    })


    const updateAuthorized = Effect.fn("Repository.update")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, value: typeof canonicalRowSchema.Type & Readonly<Record<string, unknown>>,
    ) {
      const versionField = Option.fromNullishOr(version)

      const expected = yield* Option.match(versionField, {
        onNone: Function.constant(noVersion),
        onSome: (field) => pipe(decodeVersion(value[field]), Effect.map(Option.some)),
      })

      return yield* replaceExisting(store, permission, "update", value[table.identifier], value, expected)
    })

    const patchAuthorized = Effect.fn("Repository.patch")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, key: CanonicalId, changes: ResourceChanges<S, CanonicalKey, Version>, ...expectedVersions: ExpectedVersion<Version>
    ) {
      if (Record.has(changes, table.identifier)) return yield* inputFailure(`patch must not provide immutable field ${table.identifier}`)
      const expectedVersion = Array.head(expectedVersions)
      const hasVersion = !Predicate.isUndefined(version)
      const changesVersion = hasVersion && Record.has(changes, version)
      const missingExpectedVersion = hasVersion && Option.isNone(expectedVersion)
      const invalidVersion = changesVersion || missingExpectedVersion
      if (invalidVersion) return yield* inputFailure(`patch must provide expectedVersion and must not provide version ${version}`)
      return yield* replaceExisting(store, permission, "patch", key, changes, expectedVersion)
    })


    const removeAuthorized = Effect.fn("Repository.remove")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, key: CanonicalId,
    ) {
      const encoded = yield* encodeKey(key)
      const stored = yield* selectKey(store, permission, encoded)
      if (Option.isNone(stored)) return yield* missing(key)
      const current = yield* decodeRow(stored.value)
      const row = Option.some(current)
      yield* authorize("remove", permission.subject, row)
      const removed = yield* store.remove(table, encoded, permission)
      if (!removed) return yield* missing(key)
    })

    const storageField = (field: string) => table.columns[field as keyof typeof table.columns].storageSchema
    const identifierColumn = table.columns[table.identifier as keyof typeof table.columns]
    const storedIdentifier = storageSchema.fields[table.identifier]
    const sameIdentifier = implicitIdentifier || equals(canonicalIdentifierSchema, storedIdentifier)
    const orderableIdentifier = identifierColumn.orderable && sameIdentifier
    const invalidOrdering = !orderableIdentifier
    const supportsList = Boolean(options.operations.list)
    const unsupportedList = supportsList && invalidOrdering

    if (unsupportedList) {
      pipe(definitionFailure("list identifier must preserve canonical ordering in storage"), Effect.runSync)
    }

    const makeOrder = ([field, direction]: readonly [string, "asc" | "desc"]) =>
      new RepositoryOrder({ field, direction })

    const configuredOrder = Array.map(declaredOrder, makeOrder)

    const isIdentifierOrder = (entry: RepositoryOrder) =>
      equals(entry.field, table.identifier)

    const includesIdentifier = Array.some(configuredOrder, isIdentifierOrder)
    const order = includesIdentifier ? configuredOrder : Array.append(configuredOrder, identifierOrder)
    const cursorOrder = Array.map(order, ({ field, direction }) => [field, direction])

    const cursorScope = JSON.stringify({
      resource: table.name,
      filter: filterFields,
      range: rangeFields,
      order: cursorOrder,
    })

    const canonicalField = (field: string) => pipe(
      Record.get(options.schema.fields, field),
      Option.getOrThrow,
    )

    const invalidListLimit = (limit: number) => inputFailure(`list limit must be between 1 and ${limit}`)
    const invalidListFilter = (field: string) => inputFailure(`filter ${field} is not declared`)
    const invalidListRange = (field: string) => inputFailure(`range ${field} is not declared`)
    const invalidCursorError = inputFailure("invalid list cursor")
    const invalidListCursor = Function.constant(invalidCursorError)

    const listPlan = SqliteList.make({
      filter: filterFields,
      range: rangeFields,
      order,
      maximum,
      scope: cursorScope,
      canonicalField,
      storageField,
      limitSchema: PageLimitSchema,
      errors: {
        limit: invalidListLimit,
        filter: invalidListFilter,
        range: invalidListRange,
        invalidCursor: invalidListCursor,
        cursorMismatch: invalidListCursor,
        codec: repositoryFailure,
        cursorEncoding: repositoryFailure,
      },
    })

    const listAuthorized = Effect.fn("Repository.list")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, input: ResourceListRequest<S, List> = {},
    ) {
      if (!orderableIdentifier) return yield* inputFailure("list identifier must preserve canonical ordering in storage")
      const requestedFilter = (input.filter ?? Record.empty()) as RepositorySelect["filter"]
      const requestedRange = (input.range ?? Record.empty()) as RepositorySelect["range"]
      const requestedLimit = Option.fromNullishOr(input.limit)
      const requestedCursor = Option.fromNullishOr(input.cursor)

      const prepared = yield* listPlan.prepare<Storage["EncodingServices"]>(
        requestedFilter,
        requestedRange,
        requestedLimit,
        requestedCursor,
      )

      const rows = yield* store.select(table, prepared.query, permission)
      const readListRow = (row: Readonly<Record<string, unknown>>) => readable(permission.subject, row)

      const decodeListRows = (stored: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
        Effect.forEach(stored, readListRow)

      return yield* listPlan.page(prepared, rows, decodeListRows)
    })

    // Type the shared empty record once because the transition changes type is generic.
    const noTransitionChanges = Struct.assign(noChanges, noChanges) as TransitionChanges<S, CanonicalKey, Version, Transition>

    const transitionAuthorized = Effect.fn("Repository.transition")(function* (
      store: RepositoryStore["Service"],
      permission: RepositoryAccess,
      key: CanonicalId,
      action: string,
      changes: TransitionChanges<S, CanonicalKey, Version, Transition> = noTransitionChanges,
      ...expectedVersions: ExpectedVersion<Version>
    ) {
      if (Predicate.isUndefined(transition)) return yield* inputFailure("resource does not declare transitions")
      const changesIdentifier = Record.has(changes, table.identifier)
      const changesTransition = Record.has(changes, transition.field)
      const versionField = Option.fromNullishOr(version)
      const changesVersion = Option.exists(versionField, (field) => Record.has(changes, field))
      const identifierOrTransition = changesIdentifier || changesTransition
      const immutableChanges = identifierOrTransition || changesVersion
      if (immutableChanges) return yield* inputFailure("transition changes contain an immutable field")
      const expectedVersionValue = Array.head(expectedVersions)
      const missingExpectedVersion = Option.isNone(expectedVersionValue)

      const needsExpectedVersion = Option.match(versionField, {
        onNone: Function.constant(false),
        onSome: Function.constant(missingExpectedVersion),
      })

      if (needsExpectedVersion) return yield* inputFailure("transition must provide expectedVersion")
      const encodedKey = yield* encodeKey(key)
      const stored = yield* selectKey(store, permission, encodedKey)
      if (Option.isNone(stored)) return yield* missing(key)
      const current = yield* decodeRow(stored.value)
      const keyText = String(key)
      const source = pipe(Record.get(current, transition.field), Option.getOrThrow)
      const sourceActual = String(source)
      const to = yield* transition.guard(action as never, keyText, sourceActual)
      const encodedCurrent = yield* encodeRow(current)
      const encodedStatus = pipe(Record.get(encodedCurrent, transition.field), Option.getOrThrow)
      const statusGuard = Record.singleton(transition.field, encodedStatus)
      const withChanges = Struct.assign(current, changes)
      const statusChange = Record.singleton(transition.field, to)
      const candidate = Struct.assign(withChanges, statusChange)

      const versioned = Option.match(versionField, {
        onNone: () => new Replacement({ next: candidate, expected: current }),
        onSome: (field) => {
          const expectedValue = Option.getOrThrow(expectedVersionValue)
          const next = Struct.assign(candidate, { [field]: expectedValue + 1 })
          const expected = Struct.assign(current, { [field]: expectedValue })
          return new Replacement({ next, expected })
        },
      })

      const encodedExpected = yield* encodeRow(versioned.expected)
      const encoded = yield* encodeRow(versioned.next)

      const versionGuard = Option.match(versionField, {
        onNone: Record.empty,
        onSome: (field) => Record.singleton(field, encodedExpected[field]),
      })

      const currentValue = Option.some(current)
      const nextValue = Option.some(versioned.next)
      const guard = Struct.assign(statusGuard, versionGuard)
      yield* authorize("transition", permission.subject, currentValue, nextValue)
      const updated = yield* store.update(table, encoded, permission, guard)
      if (Option.isSome(updated)) return yield* readable(permission.subject, updated.value)

      if (Option.isSome(versionField)) {
        const expectedValue = Option.getOrThrow(expectedVersionValue)
        return yield* VersionConflict.make({ resource: table.name, key: String(key), expectedVersion: expectedValue })
      }


      const refreshed = yield* selectKey(store, permission, encodedKey)
      if (Option.isNone(refreshed)) return yield* missing(key)
      const actual = yield* decodeRow(refreshed.value)
      const actualStatus = pipe(Record.get(actual, transition.field), Option.getOrThrow)
      const actualText = String(actualStatus)
      const transitionError = transition.invalid(action, keyText, actualText)
      return yield* Effect.fail(transitionError)
    })

    const find = withAccess("read", findAuthorized)
    const get = withAccess("read", getAuthorized)
    const list = withAccess("read", listAuthorized)
    const create = withAccess("create", createAuthorized)
    const update = withAccess("update", updateAuthorized)
    const patch = withAccess("patch", patchAuthorized)
    const remove = withAccess("remove", removeAuthorized)
    const transitionRepository = withAccess("transition", transitionAuthorized)



    const ensureCreateAuthorized = Effect.fn("Repository.ensureCreate")(function* (store: RepositoryStore["Service"], permission: RepositoryAccess, row: CanonicalRow) {

      const encoded = yield* encodeRow(row)
      const next = Option.some(row)
      yield* authorize("create", permission.subject, absentAuthorizationValue, next)
      const stored = yield* store.insert(table, encoded)
      return yield* readable(permission.subject, stored)
    })

    const ensureCreate = withAccess("create", ensureCreateAuthorized)



    const ensure = Effect.fn("Repository.ensure")(function* (row: CanonicalRow & Readonly<Record<string, unknown>>) {
      const key = row[table.identifier as CanonicalKey] as CanonicalId
      const found = yield* find(key)
      if (Option.isSome(found)) return found.value
      return yield* pipe(ensureCreate(row), Effect.catchIf(isUniqueViolation, () => get(key)))
    })


    const repository = { find, get, list, create, update, patch, remove, ensure, transition: transitionRepository }
    const CreateShapeSchema = Schema.Struct(creationPlan.inputFields)
    const createInputSchema = Schema.make<Schema.Codec<ResourceDraft<S, Creation, Version>, unknown, S["DecodingServices"], S["EncodingServices"]>>(CreateShapeSchema.ast)
    const IdentifierShapeSchema = Schema.Record(Schema.Literal(table.identifier), canonicalIdentifierSchema)
    const identifierRequestSchema = Schema.make<Schema.Codec<Readonly<Record<CanonicalKey, CanonicalId>>, unknown, S["DecodingServices"], S["EncodingServices"]>>(IdentifierShapeSchema.ast)
    const canonicalRowWireSchema = Schema.toCodecJson(canonicalRowSchema)
    const createWireSchema = Schema.toCodecJson(createInputSchema)
    const identifierWireSchema = Schema.toCodecJson(identifierRequestSchema)
    const PageSchema = Page.schema(canonicalRowWireSchema)
    const listInputSchema = Schema.make<Schema.Codec<ResourceListRequest<S, List>, unknown, S["DecodingServices"], S["EncodingServices"]>>(listPlan.input.ast)
    const listWireSchema = Schema.toCodecJson(listInputSchema)
    const canonicalMutableFields = Record.remove(options.schema.fields, table.identifier)

    const mutableFields = Predicate.isUndefined(version)
      ? canonicalMutableFields
      : Record.remove(canonicalMutableFields, version as never)

    const optionalMutableFields = Record.map(mutableFields, Schema.optionalKey)
    const patchFields = Record.set(optionalMutableFields, table.identifier, ForbiddenFieldSchema)
    const PatchFieldsSchema = Schema.Struct(patchFields)



    const PatchShapeSchema = Predicate.isUndefined(version)

      ? Schema.Struct({ key: canonicalIdentifierSchema, changes: PatchFieldsSchema })
      : Schema.Struct({ key: canonicalIdentifierSchema, expectedVersion: Schema.Int, changes: PatchFieldsSchema })

    const patchInputSchema = Schema.make<Schema.Codec<Readonly<{ key: CanonicalId; changes: ResourceChanges<S, CanonicalKey, Version> }> & Readonly<Partial<{ expectedVersion: number }>>, unknown, S["DecodingServices"], S["EncodingServices"]>>(PatchShapeSchema.ast)
    const patchWireSchema = Schema.toCodecJson(patchInputSchema)



    const transitionFieldsSchema = (field: string) => {
      const optionalFields = Record.map(mutableFields, Schema.optionalKey)
      const immutableIdentifier = Record.set(optionalFields, table.identifier, ForbiddenFieldSchema)
      const transitionFields = Record.set(immutableIdentifier, field, ForbiddenFieldSchema)
      return Schema.Struct(transitionFields)
    }


    const TransitionFieldsSchema = Option.match(transitionOption, {
      onNone: Function.constant(PatchFieldsSchema),
      onSome: (definition) => transitionFieldsSchema(definition.field),
    })




    const changesFieldSchema = Schema.optionalKey(TransitionFieldsSchema)

    const transitionShapeSchema = Option.match(transitionOption, {
      onNone: () => Schema.Struct({ key: canonicalIdentifierSchema, action: Schema.String, changes: changesFieldSchema }),
      onSome: (definition) => Option.match(versionOption, {
        onNone: () => Schema.Struct({ key: canonicalIdentifierSchema, action: definition.actions, changes: changesFieldSchema }),
        onSome: () => Schema.Struct({ key: canonicalIdentifierSchema, action: definition.actions, expectedVersion: Schema.Int, changes: changesFieldSchema }),
      }),
    })

    type TransitionInput = Readonly<{ key: CanonicalId; action: string }>
      & Readonly<Partial<{ changes: TransitionChanges<S, CanonicalKey, Version, Transition> }>>
      & (Version extends string ? Readonly<{ expectedVersion: number }> : unknown)

    const transitionJsonSchema = Schema.toCodecJson(transitionShapeSchema)
    const transitionInputSchema = Schema.make<Schema.Codec<TransitionInput, unknown, S["DecodingServices"], S["EncodingServices"]>>(transitionJsonSchema.ast)
    const isPublic = equals(options.authorization._tag, "Public")
    const resourceErrorsSchema = isPublic ? PublicResourceErrorSchema : ResourceErrorSchema
    const versionedErrorsSchema = Schema.Union([resourceErrorsSchema, VersionConflict])

    const errorSchema = Option.match(versionOption, {
      onNone: Function.constant(resourceErrorsSchema),
      onSome: Function.constant(versionedErrorsSchema),
    }) as ResourceErrors<Auth>

    // Name the concrete error class because narrowing the generic would widen it to Schema.Top.
    type TransitionError = Transition extends { readonly Error: infer Declared extends Schema.Top } ? Declared : typeof Schema.Never
    const declaredTransitionErrors = Option.map(transitionOption, Struct.get("Error"))
    const declaredTransitionErrorSchema = Option.getOrElse(declaredTransitionErrors, Function.constant(Schema.Never)) as TransitionError
    const transitionErrorSchema = Schema.Union([errorSchema, declaredTransitionErrorSchema])
    const identifierFrom = (input: typeof identifierRequestSchema.Type) => input[table.identifier as CanonicalKey]
    const getHandler = flow(identifierFrom, repository.get)
    const removeHandler = flow(identifierFrom, repository.remove)


    // Read the wire field into the tuple the versioned signature expects because RPC input carries it as a field.
    const expectedVersions = (input: Readonly<Record<string, unknown>>) => {
      const supplied = Record.get(input, "expectedVersion")
      const integer = Option.filter(supplied, Schema.is(Schema.Int))
      const versions = Option.match(integer, { onNone: () => [] as const, onSome: (value) => [value] as const })
      return versions as ExpectedVersion<Version>
    }

    const patchHandler = Effect.fn("Resource.patch")(function* (input: typeof patchInputSchema.Type) {
      const versions = expectedVersions(input)
      return yield* repository.patch(input.key, input.changes, ...versions)
    })

    const transitionHandler = Effect.fn("Resource.transition")(function* (input: typeof transitionInputSchema.Type) {
      const changes = input.changes ?? noTransitionChanges
      const versions = expectedVersions(input)
      return yield* repository.transition(input.key, input.action, changes, ...versions)
    })

    const getRpc = Rpc.make(`${options.name}.get`, { payload: identifierWireSchema, success: canonicalRowWireSchema, error: errorSchema })
    const listRpc = Rpc.make(`${options.name}.list`, { payload: listWireSchema, success: PageSchema, error: errorSchema })
    const createRpc = Rpc.make(`${options.name}.create`, { payload: createWireSchema, success: canonicalRowWireSchema, error: errorSchema })
    const updateRpc = Rpc.make(`${options.name}.update`, { payload: canonicalRowWireSchema, success: canonicalRowWireSchema, error: errorSchema })
    const patchRpc = Rpc.make(`${options.name}.patch`, { payload: patchWireSchema, success: canonicalRowWireSchema, error: errorSchema })
    const removeRpc = Rpc.make(`${options.name}.remove`, { payload: identifierWireSchema, success: Schema.Void, error: errorSchema })
    const transitionRpc = Rpc.make(`${options.name}.transition`, { payload: transitionInputSchema, success: canonicalRowWireSchema, error: transitionErrorSchema })

    const contracts = Object.freeze({
      get: getRpc,
      list: listRpc,
      create: createRpc,
      update: updateRpc,
      patch: patchRpc,
      remove: removeRpc,
      transition: transitionRpc,
    })



    const definitions = new Data.Class({
      get: { rpc: contracts.get, handler: getHandler },
      list: { rpc: contracts.list, handler: repository.list },
      create: { rpc: contracts.create, handler: repository.create },
      update: { rpc: contracts.update, handler: repository.update },
      patch: { rpc: contracts.patch, handler: patchHandler },
      remove: { rpc: contracts.remove, handler: removeHandler },
      transition: { rpc: contracts.transition, handler: transitionHandler },
    })

    type Operation = PublishedOperation<Operations>
    type SelectedRpc = Extract<typeof definitions[ResourceOperation]["rpc"], { readonly _tag: `${Name}.${Operation}` }>
    const selected = Array.map(operations, (operation) => definitions[operation].rpc) as Array<SelectedRpc>
    const selectedGroup = RpcGroup.make(...selected)
    type PublishedRpc = Auth extends PolicyAuthorization ? Rpc.AddMiddleware<SelectedRpc, typeof AuthorizationRpc> : SelectedRpc
    const group = (equals(options.authorization._tag, "Policy") ? selectedGroup.middleware(AuthorizationRpc) : selectedGroup) as RpcGroup.Any as RpcGroup.RpcGroup<PublishedRpc>
    const handlerRecord = pipe(operations, Array.map((operation) => [`${options.name}.${operation}`, definitions[operation].handler] as const), Record.fromEntries)
    const handlers = selectedGroup.toLayer(handlerRecord as typeof handlerRecord & RpcGroup.HandlersFrom<SelectedRpc>) as Layer.Layer<Rpc.ToHandler<SelectedRpc>, never, Effect.Services<ReturnType<typeof definitions[Operation]["handler"]>>>


    return Struct.assign(options, {
      _tag: "CompiledResource" as const,
      operations,
      published,
      storage: storageSchema,
      table,
      creation: creationPlan.inspection,
      list: listPolicy,
      version,
      transitions: transition,
      createInputSchema,
      contracts,
      repository,
      group,
      handlers,
    })
}

type SourceKeys<
  Sources,
  Tag extends CreationSource["_tag"],
> = {
  readonly [Key in keyof Sources]-?:
    Extract<NonNullable<Sources[Key]>, { readonly _tag: Tag }> extends never ? never : Key
}[keyof Sources]

type DefaultsFrom<Sources> = {
  readonly [Key in SourceKeys<Sources, "Default">]:
    Extract<NonNullable<Sources[Key]>, { readonly _tag: "Default" }> extends
      { readonly value: infer Value } ? Value : never
}

type GeneratedFrom<Sources> = {
  readonly [Key in SourceKeys<Sources, "Generated">]:
    Extract<NonNullable<Sources[Key]>, { readonly _tag: "Generated" }> extends
      { readonly token: infer Token } ? Token : never
}

type SubjectFrom<Sources> = {
  readonly [Key in SourceKeys<Sources, "Subject">]:
    Extract<NonNullable<Sources[Key]>, { readonly _tag: "Subject" }> extends
      { readonly operand: infer Operand } ? Operand : never
}

type CreationSourcesFrom<Capability> =
  Capability extends { readonly sources: infer Sources } ? Sources : {}

type CreationPolicyFrom<Capability> =
  Readonly<{
    defaults: DefaultsFrom<CreationSourcesFrom<Capability>>
    generated: GeneratedFrom<CreationSourcesFrom<Capability>>
    fromSubject: SubjectFrom<CreationSourcesFrom<Capability>>
  }> & (
    Capability extends { readonly publish: false }
      ? Readonly<{ publish: false }>
      : unknown
  )

type CapabilityValue<Capability extends ResourceCapability> =
  Capability extends { readonly _tag: "Create" }
    ? CreationPolicyFrom<Capability>
    : Capability extends { readonly _tag: "List" }
      ? Omit<Capability, "_tag">
      : true

type CapabilityOperations<
  Capabilities extends ReadonlyArray<ResourceCapability>,
> = {
  readonly [Capability in Capabilities[number] as Lowercase<Capability["_tag"]>]:
    CapabilityValue<Capability>
}
type CompleteResourceOperations<
  S extends StructSchema,
  Auth extends AuthorizationDefinition,
  Capabilities extends ReadonlyArray<ResourceCapability>,
  Declared extends Partial<ResourceOperations<S, Auth>> = CapabilityOperations<Capabilities>,
> = Omit<ResourceOperations<S, Auth>, keyof Declared> & Declared

interface CreationOperation {
  readonly defaults: Readonly<Record<string, unknown>>
  readonly generated: Readonly<Record<string, "uuidV7" | "now">>
  readonly fromSubject: Readonly<Record<string, unknown>>
}

const emptyCreationOperation: CreationOperation = {
  defaults: {},
  generated: {},
  fromSubject: {},
}

const creationOperation = (
  capability: Extract<ResourceCapability, { readonly _tag: "Create" }>,
) => {
  const entries = globalThis.Object.entries(
    capability.sources ?? {},
  ) as ReadonlyArray<readonly [string, CreationSource]>
  const operation = Array.reduce(entries, emptyCreationOperation, (state, [field, source]) => pipe(
    Match.value(source),
    Match.tagsExhaustive({
      Input: () => state,
      Default: ({ value }) => ({
        ...state,
        defaults: Record.set(state.defaults, field, value),
      }),
      Generated: ({ token }) => ({
        ...state,
        generated: Record.set(state.generated, field, token),
      }),
      Subject: ({ operand }) => ({
        ...state,
        fromSubject: Record.set(state.fromSubject, field, operand),
      }),
    }),
  ))

  return {
    ...operation,
    ...(capability.publish === false ? { publish: false as const } : {}),
  }
}

const operationEntry = Match.type<ResourceCapability>().pipe(
  Match.tagsExhaustive({
    Get: () => ["get", true] as const,
    List: ({ _tag: _, ...policy }) => ["list", policy] as const,
    Create: (capability) => ["create", creationOperation(capability)] as const,
    Update: () => ["update", true] as const,
    Remove: () => ["remove", true] as const,
    Patch: () => ["patch", true] as const,
    Transition: () => ["transition", true] as const,
  }),
)

const operationsFrom = <
  const Capabilities extends ReadonlyArray<ResourceCapability>,
>(declared: Capabilities) =>
  Record.fromEntries(Array.map(declared, operationEntry)) as
    CapabilityOperations<Capabilities>

export interface ResourceReference<
  Target extends AnyResourceSpec = AnyResourceSpec,
> {
  readonly _tag: "ResourceReference"
  readonly resource: Target
  readonly fields: ReadonlyArray<string>
}

type TableForeignKeyInput<Fields extends string> =
  NonNullable<TableRelationsInput<Fields>["foreignKeys"]>[number]

export type ResourceRelationsInput<Fields extends string = string> =
  Omit<TableRelationsInput<Fields>, "foreignKeys">
  & Readonly<Partial<{
    foreignKeys: ReadonlyArray<
      Omit<TableForeignKeyInput<Fields>, "references">
      & Readonly<{ references: ResourceReference }>
    >
  }>>

export interface AnyResourceSpec {
  readonly _tag: "ResourceSpec"
  readonly name: string
  readonly schema: StructSchema
  readonly authorization: AuthorizationDefinition
  readonly capabilities: ReadonlyArray<ResourceCapability>
  readonly storage?: StructSchema
  readonly relations?: ResourceRelationsInput
  readonly version?: string
  readonly transitions?: TransitionMachine
  readonly _types?: Readonly<{
    name: string
    schema: StructSchema
    storage: StructSchema
    authorization: AuthorizationDefinition
    capabilities: ReadonlyArray<ResourceCapability>
    version: string | undefined
    transitions: TransitionMachine | undefined
  }>
}

export interface ResourceSpec<
  Name extends string = string,
  S extends StructSchema = StructSchema,
  Storage extends StructSchema = S,
  Auth extends AuthorizationDefinition = AuthorizationDefinition,
  Capabilities extends ReadonlyArray<ResourceCapability> =
    ReadonlyArray<ResourceCapability>,
  Version extends Extract<keyof S["fields"], string> | undefined = undefined,
  Transition extends TransitionMachine | undefined = undefined,
> extends AnyResourceSpec {
  readonly _tag: "ResourceSpec"
  readonly name: Name
  readonly schema: S
  readonly authorization: Auth
  readonly capabilities: Capabilities
  readonly storage?: Storage
  readonly relations?: ResourceRelationsInput<TableFieldName<Storage>>
  readonly version?: Version
  readonly transitions?: Transition
  readonly _types?: Readonly<{
    name: Name
    schema: S
    storage: Storage
    authorization: Auth
    capabilities: Capabilities
    version: Version
    transitions: Transition
  }>
}

type ResourceDefinitionInput = Readonly<{
  name: string
  schema: StructSchema
  authorization: AuthorizationDefinition
  capabilities: ReadonlyArray<ResourceCapability>
}> & Readonly<Partial<{
  storage: StructSchema
  relations: ResourceRelationsInput
  version: string
  transitions: TransitionMachine
}>>

type DefinitionStorage<Definition> =
  Definition extends { readonly storage: infer Storage extends StructSchema }
    ? Storage
    : DefinitionSchema<Definition>

type DefinitionVersion<Definition> =
  Definition extends { readonly version: infer Version extends string }
    ? Version & Extract<keyof DefinitionSchema<Definition>["fields"], string>
    : undefined

type DefinitionTransition<Definition> =
  Definition extends { readonly transitions: infer Transition extends TransitionMachine }
    ? Transition
    : undefined

type DefinitionName<Definition> =
  Definition extends { readonly name: infer Name extends string } ? Name : never
type DefinitionSchema<Definition> =
  Definition extends { readonly schema: infer S extends StructSchema } ? S : never
type DefinitionAuthorization<Definition> =
  Definition extends { readonly authorization: infer Auth extends AuthorizationDefinition } ? Auth : never
type DefinitionCapabilities<Definition> =
  Definition extends { readonly capabilities: infer Capabilities extends ReadonlyArray<ResourceCapability> }
    ? Capabilities
    : never

type DefinedResource<Definition> = ResourceSpec<
  DefinitionName<Definition>,
  DefinitionSchema<Definition>,
  DefinitionStorage<Definition>,
  DefinitionAuthorization<Definition>,
  DefinitionCapabilities<Definition>,
  DefinitionVersion<Definition>,
  DefinitionTransition<Definition>
>
type CapabilityValidation<
  Capability,
  S extends StructSchema,
  Auth extends AuthorizationDefinition,
> = Capability extends { readonly _tag: "Create" }
  ? Capability extends { readonly sources: infer Sources }
    ? Sources extends CreationSources<S, Auth> ? unknown : never
    : unknown
  : Capability extends { readonly _tag: "List" }
    ? Omit<Capability, "_tag"> extends ListPolicy<S> ? unknown : never
    : Capability extends ResourceCapability ? unknown : never

type CapabilitiesValidation<
  Capabilities,
  S extends StructSchema,
  Auth extends AuthorizationDefinition,
> = Capabilities extends readonly [
  infer Head extends ResourceCapability,
  ...infer Tail extends ReadonlyArray<ResourceCapability>,
]
  ? [CapabilityValidation<Head, S, Auth>] extends [never]
    ? never
    : CapabilitiesValidation<Tail, S, Auth>
  : Capabilities extends ReadonlyArray<ResourceCapability> ? unknown : never

type RelationEntryValidation<Entry, Field extends string> =
  Entry extends { readonly fields: ReadonlyArray<infer Local> }
    ? Exclude<Local, Field> extends never
      ? Entry extends { readonly scope: ReadonlyArray<infer Scope> }
        ? Exclude<Scope, Field> extends never ? unknown : never
        : unknown
      : never
    : never

type RelationEntriesValidation<Entries, Field extends string> =
  Entries extends readonly [infer Head, ...infer Tail]
    ? [RelationEntryValidation<Head, Field>] extends [never]
      ? never
      : RelationEntriesValidation<Tail, Field>
    : Entries extends ReadonlyArray<unknown> ? unknown : never

type RelationsValidation<Definition> =
  Definition extends { readonly relations: infer Relations }
    ? (
      Relations extends { readonly unique: infer Unique }
        ? RelationEntriesValidation<Unique, TableFieldName<DefinitionStorage<Definition>>>
        : unknown
    ) & (
      Relations extends { readonly indexes: infer Indexes }
        ? RelationEntriesValidation<Indexes, TableFieldName<DefinitionStorage<Definition>>>
        : unknown
    ) & (
      Relations extends { readonly foreignKeys: infer ForeignKeys }
        ? RelationEntriesValidation<ForeignKeys, TableFieldName<DefinitionStorage<Definition>>>
        : unknown
    )
    : unknown

type DefinitionValidation<Definition> =
  Definition extends Readonly<{
    name: string
    schema: infer S extends StructSchema
    authorization: infer Auth extends AuthorizationDefinition
    capabilities: infer Capabilities
  }>
    ? CapabilitiesValidation<Capabilities, S, Auth> & RelationsValidation<Definition>
    : never


const define = <
  const Definition extends Readonly<Record<string, unknown>>,
>(
  definition: Definition,
  ..._validation: [DefinitionValidation<Definition>] extends [never]
    ? readonly [invalidDefinition: never]
    : readonly []
): DefinedResource<Definition> => {
  const input = definition as unknown as ResourceDefinitionInput
  return Object.freeze({
    ...input,
    _tag: "ResourceSpec" as const,
    capabilities: Object.freeze([...input.capabilities]),
  }) as unknown as DefinedResource<Definition>
}

type ResourceRequirements<S extends StructSchema, Storage extends StructSchema> =
  | RepositoryStore
  | S["DecodingServices"]
  | S["EncodingServices"]
  | Storage["DecodingServices"]
  | Storage["EncodingServices"]

type ExactResourceRuntime<
  Runtime extends { readonly handlers: Layer.Any },
  S extends StructSchema,
  Storage extends StructSchema,
> = Omit<Runtime, "handlers"> & Readonly<{
  handlers: Layer.Layer<
    Layer.Success<Runtime["handlers"]>,
    Layer.Error<Runtime["handlers"]>,
    ResourceRequirements<S, Storage>
  >
}>


type ResourceTypes<Spec extends AnyResourceSpec> = NonNullable<Spec["_types"]>


export type ResourceRuntime<Spec extends AnyResourceSpec> =
  string extends ResourceTypes<Spec>["name"] ? Resource : ExactResourceRuntime<
    ReturnType<typeof compileResource<
      ResourceTypes<Spec>["name"],
      ResourceTypes<Spec>["schema"],
      ResourceTypes<Spec>["storage"],
      ResourceTypes<Spec>["authorization"],
      CapabilityOperations<ResourceTypes<Spec>["capabilities"]>,
      Extract<
        ResourceTypes<Spec>["version"],
        Extract<keyof ResourceTypes<Spec>["schema"]["fields"], string> | undefined
      >,
      ResourceTypes<Spec>["transitions"]
    >>,
    ResourceTypes<Spec>["schema"],
    ResourceTypes<Spec>["storage"]
  >

const compiledResources = new WeakMap<AnyResourceSpec, Resource>()

const compile = <const Spec extends AnyResourceSpec>(
  spec: Spec,
): ResourceRuntime<Spec> => {
  const cached = compiledResources.get(spec)
  if (cached) return cached as unknown as ResourceRuntime<Spec>

  const { _tag: _, capabilities: declared, ...definition } = spec
  const operations = operationsFrom(declared)
  const relations = Option.match(Option.fromNullishOr(spec.relations), {
    onNone: Function.constant(undefined),
    onSome: (declaredRelations) => Option.match(Option.fromNullishOr(declaredRelations.foreignKeys), {
      onNone: Function.constant(declaredRelations),
      onSome: (declaredForeignKeys) => {
        const foreignKeys = Array.map(
          declaredForeignKeys,
          ({ references, ...foreignKey }) => ({
            ...foreignKey,
            references: Table.reference(
              compile(references.resource).table,
              references.fields as ReadonlyArray<string>,
            ),
          }),
        )

        return { ...declaredRelations, foreignKeys }
      },
    }),
  })
  const compiled = compileResource({
    ...definition,
    relations,
    operations,
  } as never)

  compiledResources.set(spec, compiled)
  return compiled as unknown as ResourceRuntime<Spec>
}


type ExactRepository<
  Repository,
  S extends StructSchema,
  Storage extends StructSchema,
> = {
  readonly [Key in keyof Repository]:
    Repository[Key] extends (...arguments_: infer Arguments) => Effect.Effect<
      infer Success,
      infer Failure,
      unknown
    >
      ? (...arguments_: Arguments) => Effect.Effect<
        Success,
        Failure,
        ResourceRequirements<S, Storage>
      >
      : Repository[Key]
}

type RepositoryFor<Spec extends AnyResourceSpec> =
  string extends ResourceTypes<Spec>["name"] ? ReturnType<typeof compileResource>["repository"] : ExactRepository<
    Extract<
      ReturnType<typeof compileResource<
        ResourceTypes<Spec>["name"],
        ResourceTypes<Spec>["schema"],
        ResourceTypes<Spec>["storage"],
        ResourceTypes<Spec>["authorization"],
        CompleteResourceOperations<
          ResourceTypes<Spec>["schema"],
          ResourceTypes<Spec>["authorization"],
          ResourceTypes<Spec>["capabilities"]
        >,
        Extract<
          ResourceTypes<Spec>["version"],
          Extract<keyof ResourceTypes<Spec>["schema"]["fields"], string> | undefined
        >,
        TransitionMachine | undefined
      >>,
      { readonly repository: unknown }
    >["repository"],
    ResourceTypes<Spec>["schema"],
    ResourceTypes<Spec>["storage"]
  >

type ExactTable<
  ResourceTable extends Table,
  S extends StructSchema,
  Storage extends StructSchema,
> = Omit<ResourceTable, "rowSchema"> & Readonly<{
  rowSchema: ResourceTable["rowSchema"] & Schema.Codec<
    ResourceTable["rowSchema"]["Type"],
    ResourceTable["rowSchema"]["Encoded"],
    S["DecodingServices"] | Storage["DecodingServices"],
    S["EncodingServices"] | Storage["EncodingServices"]
  >
}>

export type ResourceTable<Spec extends AnyResourceSpec> =
  string extends ResourceTypes<Spec>["name"] ? Table
    : ResourceRuntime<Spec> extends { readonly table: infer ResourceTable extends Table }
      ? ExactTable<
        ResourceTable,
        ResourceTypes<Spec>["schema"],
        ResourceTypes<Spec>["storage"]
      >
      : Table

const repository = <const Spec extends AnyResourceSpec>(
  spec: Spec,
): RepositoryFor<Spec> =>
  (compile(spec) as unknown as { readonly repository: RepositoryFor<Spec> }).repository

const table = <const Spec extends AnyResourceSpec>(
  spec: Spec,
): ResourceTable<Spec> =>
  (compile(spec) as unknown as Resource).table as ResourceTable<Spec>

const reference = <
  const Target extends AnyResourceSpec,
  const Fields extends ReadonlyArray<
    Extract<keyof ResourceTable<Target>["rowSchema"]["fields"], string>
  >,
>(
  resource: Target,
  fields: Fields,
): ResourceReference<Target> => Object.freeze({
  _tag: "ResourceReference" as const,
  resource,
  fields: Object.freeze([...fields]),
})

export const Resource = {
  define,
  compile,
  repository,
  table,
  capabilities,
  crud,
  get: capabilityGet,
  list: capabilityList,
  create: capabilityCreate,
  update: capabilityUpdate,
  remove: capabilityRemove,
  patch: capabilityPatch,
  transition: capabilityTransition,
  reference,
  input: creationInput,
  default: creationDefault,
  generated: creationGenerated,
  fromSubject: creationSubject,
}
