import { Array, Data, Effect, Equivalence, flow, Function, Layer, Option, Order, Predicate, Record, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { RepositoryAccess, RepositoryError, RepositorySelect, RepositoryStore, ResourceNotFound } from "./repository-store.ts"
import { Table, type TableField, type TableFieldName, type TableRelationsInput, withImplicitIdentifier } from "./table.ts"
import { Creation, type CreationInspection } from "./resource-creation.ts"
import type { RpcBundle } from "./rpc-contract.ts"
import { DomainIdentifier, type StructSchema } from "./domain.ts"
import { Authorization, AuthorizationValues, Forbidden, Unauthenticated, type AuthorizationAction, type AuthorizationDefinition, type AuthorizationRuntime, type PolicyAuthorization, type SubjectOperand } from "./authorization.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
const PageLimitSchema = Schema.Int.check(Schema.isGreaterThan(0))
const OptionalLimitSchema = Schema.optionalKey(PageLimitSchema)
const OptionalCursorSchema = Schema.optionalKey(Schema.String)
const ForbiddenFieldSchema = Schema.optionalKey(Schema.Never)
const NextCursorSchema = Schema.NullOr(Schema.String)
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
type ResourceOperation = "get" | "list" | "create" | "update" | "remove" | "patch"

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

type CreationDefaultKeys<Creation> = Creation extends { readonly defaults: infer Defaults }
  ? Extract<keyof Defaults, string> : never

type CreationGeneratedKeys<Creation> = Creation extends { readonly generated: infer Generated }
  ? Extract<keyof Generated, string> : never

type CreationSubjectKeys<Creation> = Creation extends { readonly fromSubject: infer Bindings }
  ? Extract<keyof Bindings, string> : never

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

type ListPolicy<S extends StructSchema> = Readonly<Partial<{
  filter: ReadonlyArray<Extract<keyof S["fields"], string>>
  limit: number
  publish: false
}>>

type ResourceDraft<S extends StructSchema, Creation> =
  Omit<S["Type"], CreationDefaultKeys<Creation> | CreationGeneratedKeys<Creation> | CreationSubjectKeys<Creation>> &
  Partial<Pick<S["Type"], Extract<CreationDefaultKeys<Creation>, keyof S["Type"]>>>

type ResourceChanges<S extends StructSchema, Key extends string> = Partial<Omit<S["Type"], Key>>

type ListInput<S extends StructSchema, Policy extends ListPolicy<S>> = Readonly<Partial<{
  filter: Policy["filter"] extends ReadonlyArray<infer Field>
    ? Partial<Pick<S["Type"], Extract<Field, keyof S["Type"]>>>
    : Readonly<Record<string, never>>
  limit: number
  cursor: string
}>>

const ListOperationSchema = Schema.Struct({
  filter: Schema.optionalKey(Schema.Array(Schema.String)),
  limit: Schema.optionalKey(PageLimitSchema),
  publish: Schema.optionalKey(Schema.Literal(false)),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

interface ListOperation extends Schema.Schema.Type<typeof ListOperationSchema> {}

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
}).annotate({ parseOptions: { onExcessProperty: "error" } })

interface Operations extends Schema.Schema.Type<typeof OperationsSchema> {}
const decodeOperations = Schema.decodeUnknownEffect(OperationsSchema)

type CompatibleStorage<Canonical extends StructSchema, Storage extends StructSchema> =
  Storage["Type"] extends Canonical["Type"] ? Canonical["Type"] extends Storage["Type"] ? unknown : never : never

const ResourceErrorSchema = Schema.Union([RepositoryError, ResourceNotFound, Unauthenticated, Forbidden])
const PublicResourceErrorSchema = Schema.Union([RepositoryError, ResourceNotFound])
type ResourceErrors<Auth> = Auth extends typeof Authorization.public ? typeof PublicResourceErrorSchema : typeof ResourceErrorSchema

type AuthorizedRepository<Repository, Auth> = {
  readonly [Key in keyof Repository]: Repository[Key] extends (...args: infer Args) => Effect.Effect<infer Value, infer Error, infer Services>
    ? (...args: Args) => Effect.Effect<Value, Auth extends typeof Authorization.public ? Exclude<Error, Forbidden | Unauthenticated> : Error, Services>
    : never
}

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

// Bind once because identity, storage, and transaction scope belong to each invocation.
const withAuthorization = (authorization: AuthorizationRuntime, table: Table) =>
  <Args extends ReadonlyArray<unknown>, A, E, R>(
    action: AuthorizationAction,
    use: (store: RepositoryStore["Service"], permission: RepositoryAccess, ...args: Args) => Effect.Effect<A, E, R>,
  ) => {
    const reading = equals(action, "read")

    return Effect.fn("Repository.withAuthorization")(function* (...args: [...Args]) {
      const subject = yield* authorization.subject(action)
      const store = yield* RepositoryStore
      const permission = new RepositoryAccess({ policy: authorization.visibility, subject })
      const effect = use(store, permission, ...args)
      return yield* (reading ? effect : store.transaction(table, effect))
    })
  }

export interface Resource extends RpcBundle {
  readonly name: string
  readonly schema: StructSchema
  readonly storage: StructSchema
  readonly table: Table
  readonly operations: ReadonlyArray<ResourceOperation>
  readonly authorization: AuthorizationDefinition
  readonly creation: CreationInspection
  readonly list: ListPolicy<StructSchema>
}

export const Resource = {
  crud: Object.freeze({ get: true, list: true, create: true, update: true, remove: true }) as Readonly<Record<"get" | "list" | "create" | "update" | "remove", true>>,

  make<
    const Name extends string,
    const S extends StructSchema,
    const Storage extends StructSchema = S,
    const Auth extends AuthorizationDefinition = AuthorizationDefinition,
    const Operations extends ResourceOperations<S, Auth> = ResourceOperations<S, Auth>,
  >(options: Readonly<{ name: Name; schema: S; operations: Operations; authorization: Auth }> & Readonly<Partial<{
    storage: Storage
    relations: TableRelationsInput<TableFieldName<Storage>>
  }>> & CompatibleStorage<S, Storage>) {
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

    const defaults: Readonly<Record<string, unknown>> = createPolicy?.defaults ?? Record.empty()
    const declaredGenerated: Readonly<Record<string, "uuidV7" | "now">> = createPolicy?.generated ?? Record.empty()
    const subjectBindings: Readonly<Record<string, SubjectOperand<unknown>>> = createPolicy?.fromSubject ?? Record.empty()
    const canonicalNames = pipe(options.schema.fields, Record.keys, Array.sort(Order.String))
    const storageNames = pipe(storageSchema.fields, Record.keys, Array.sort(Order.String))
    const filterFields: ReadonlyArray<string> = declaredListPolicy?.filter ?? []
    const maximum = declaredListPolicy?.limit ?? 50
    const listPolicy: ListPolicy<S> = new Data.Class({ filter: filterFields as ReadonlyArray<Extract<keyof S["fields"], string>>, limit: maximum })

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


      yield* Effect.forEach(filterFields, (field) => {
        const canonical = Record.has(options.schema.fields, field)
        const physical = Array.some(table.fields, fieldNamed(field))
        const valid = canonical && physical
        return valid ? Effect.void : definitionFailure(`declares unknown list filter ${field}`)
      }, { discard: true })


    })

    Effect.runSync(validateDefinition)
    const implicitIdentifier = !Record.has(options.schema.fields, table.identifier)

    const canonicalRowSchema = (
      implicitIdentifier ? withImplicitIdentifier(options.schema) : options.schema
    ) as Schema.Codec<
      CanonicalRow,
      unknown,
      S["DecodingServices"],
      S["EncodingServices"]
    >

    const canonicalIdentifierSchema = pipe(
      Record.get(options.schema.fields, table.identifier),
      Option.getOrElse(() => table.identifierSchema),
    )

    const authorization = pipe(Authorization.compile({
      authorization: options.authorization,
      resource: options.schema,
      storage: storageSchema,
      table,
    }), Effect.runSync)


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
    const storageRowsSchema = Schema.Array(table.storageSchema)

    const decodeRows = flow(
      Schema.decodeUnknownEffect(storageRowsSchema),
      Effect.mapError(repositoryFailure),
      Effect.flatMap(Effect.forEach(validateCanonical)),
    )

    const missing = (key: unknown) => ResourceNotFound.make({ resource: table.name, key: String(key) })
    const withAccess = withAuthorization(authorization, table)

    const readable = Effect.fn("Repository.readable")(function* (subject: RepositoryAccess["subject"], stored: unknown) {
      const result = yield* decodeRow(stored)
      const row = Option.some(result)
      yield* authorize("read", subject, row)
      return result
    })

    const creationSchema = implicitIdentifier ? withImplicitIdentifier(options.schema) : options.schema
    const generatedIdentifier = implicitIdentifier ? Option.some(table.identifier) : Option.none<string>()
    const creationPlan = pipe(Creation.compile(creationSchema.fields, defaults, declaredGenerated, subjectBindings, definitionFailure, inputFailure, generatedIdentifier), Effect.runSync)

    const createAuthorized = Effect.fn("Repository.create")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, input: ResourceDraft<S, Creation>,
    ) {
      const complete = yield* creationPlan.materialize(input, permission.subject)
      const encoded = yield* encodeRow(complete)
      const next = Option.some(complete)
      yield* authorize("create", permission.subject, absentAuthorizationValue, next)
      const stored = yield* store.insert(table, encoded)
      return yield* readable(permission.subject, stored)
    })

    const selectKey = Effect.fn("Repository.selectKey")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, key: unknown,
    ) {
      const filter = Record.singleton(table.identifier, key)
      const after = Option.none()
      const query = new RepositorySelect({ filter, after, limit: 1 })
      const rows = yield* store.select(table, query, permission)
      return Array.head(rows)
    })

    const findAuthorized = Effect.fn("Repository.find")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, key: CanonicalId,
    ) {
      const encoded = yield* encodeKey(key)
      const stored = yield* selectKey(store, permission, encoded)
      if (Option.isNone(stored)) return Option.none<CanonicalRow>()
      return yield* pipe(decodeRow(stored.value), Effect.map(Option.some))
    })

    const getAuthorized = Effect.fn("Repository.get")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, key: CanonicalId,
    ) {
      const found = yield* findAuthorized(store, permission, key)
      if (Option.isNone(found)) return yield* missing(key)
      return found.value
    })

    const replaceExisting = Effect.fn("Repository.replaceExisting")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess,
      action: Extract<AuthorizationAction, "update" | "patch">,
      key: unknown, changes: Readonly<Record<string, unknown>>,
    ) {
      const encodedKey = yield* encodeKey(key)
      const stored = yield* selectKey(store, permission, encodedKey)
      if (Option.isNone(stored)) return yield* missing(key)
      const current = yield* decodeRow(stored.value)
      const partial = equals(action, "patch")
      const candidate = partial ? Struct.assign(current, changes) : changes
      const encoded = yield* encodeRow(candidate)
      const row = Option.some(current)
      const next = Option.some(candidate)
      yield* authorize(action, permission.subject, row, next)
      const updated = yield* store.update(table, encoded, permission)
      if (Option.isNone(updated)) return yield* missing(key)
      return yield* readable(permission.subject, updated.value)
    })

    const updateAuthorized = (
      store: RepositoryStore["Service"], permission: RepositoryAccess, value: typeof canonicalRowSchema.Type,
    ) => replaceExisting(store, permission, "update", (value as Readonly<Record<string, unknown>>)[table.identifier], value)

    const patchAuthorized = Effect.fn("Repository.patch")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, key: CanonicalId, changes: ResourceChanges<S, CanonicalKey>,
    ) {
      if (Record.has(changes, table.identifier)) return yield* inputFailure(`patch must not provide immutable field ${table.identifier}`)
      return yield* replaceExisting(store, permission, "patch", key, changes)
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

    const optionalFieldEntry = (field: string) => {
      const schema = pipe(
        Record.get(table.columns as Table["columns"], field),
        Option.map(flow(Struct.get("storageSchema"), Schema.optionalKey)),
      )

      return [field, schema] as const
    }

    const filterEntries = Array.map(filterFields, optionalFieldEntry)
    const presentFilterFields: Readonly<Record<string, Schema.Constraint>> = pipe(filterEntries, Record.fromEntries, Record.getSomes)
    const FilterSchema = Schema.Struct(presentFilterFields)
    interface Filter extends Schema.Schema.Type<typeof FilterSchema> {}
    const filterCodecSchema = Schema.make<Schema.Codec<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>, never, Storage["EncodingServices"]>>(FilterSchema.ast)
    const encodeFilter = flow(Schema.encodeUnknownEffect(filterCodecSchema), Effect.mapError(repositoryFailure))
    const identifierColumn = table.columns[table.identifier as keyof typeof table.columns]
    const storedIdentifier = storageSchema.fields[table.identifier]
    const sameIdentifier = implicitIdentifier || equals(canonicalIdentifierSchema, storedIdentifier)
    const orderableIdentifier = identifierColumn.orderable && sameIdentifier
    const invalidOrdering = !orderableIdentifier
    const unsupportedList = Array.contains(operations, "list" as PublishedOperation<Operations>) && invalidOrdering

    if (unsupportedList) {
      pipe(definitionFailure("list identifier must preserve canonical ordering in storage"), Effect.runSync)
    }

    const CursorResourceSchema = Schema.Literal(table.name)
    const CursorIdentifierSchema = Schema.toEncoded(table.identifierStorageSchema)

    const ResourceCursorSchema = Schema.Struct({
      resource: CursorResourceSchema, filter: UnknownRecordSchema, identifier: CursorIdentifierSchema,
    }).annotate({ parseOptions: { onExcessProperty: "error" } })

    interface ResourceCursor extends Schema.Schema.Type<typeof ResourceCursorSchema> {}
    const ResourceCursorJsonSchema = pipe(Schema.fromJsonString(Schema.Json), Schema.decodeTo(ResourceCursorSchema))
    const parseCursor = Schema.decodeUnknownEffect(ResourceCursorJsonSchema)
    const renderCursor = flow(Schema.encodeUnknownEffect(ResourceCursorJsonSchema), Effect.mapError(repositoryFailure))
    const MaximumPageLimitSchema = PageLimitSchema.check(Schema.isLessThanOrEqualTo(maximum))
    const isLimit = Schema.is(MaximumPageLimitSchema)
    const cursorFailure = inputFailure("invalid list cursor")

    const listAuthorized = Effect.fn("Repository.list")(function* (
      store: RepositoryStore["Service"], permission: RepositoryAccess, input: ListInput<S, List> = {},
    ) {
      if (!orderableIdentifier) return yield* inputFailure("list identifier must preserve canonical ordering in storage")
      const limit = input.limit ?? maximum
      if (!isLimit(limit)) return yield* inputFailure(`list limit must be between 1 and ${maximum}`)
      const requestedFilter = input.filter ?? Record.empty()
      const requestedNames = Record.keys(requestedFilter)

      const validateFilter = (field: string) => Array.contains(filterFields, field)
        ? Effect.void : inputFailure(`filter ${field} is not declared`)

      yield* Effect.forEach(requestedNames, validateFilter, { discard: true })

      const filter = yield* encodeFilter(requestedFilter)
      const cursorInput = Option.fromNullishOr(input.cursor)
      const expectedFilter = JSON.stringify(filter)
      const emptyCursor = Option.none<unknown>()

      const cursor = yield* Option.match(cursorInput, {
        onNone: () => Effect.succeed(emptyCursor),
        onSome: Effect.fn("Repository.cursor")(function* (source: string) {
          const decoded = yield* pipe(parseCursor(source), Effect.mapError(Function.constant(cursorFailure)))
          const actualFilter = JSON.stringify(decoded.filter)
          if (!equals(actualFilter, expectedFilter)) return yield* cursorFailure
          return Option.some(decoded.identifier)
        }),
      })

      const query = new RepositorySelect({ filter, after: cursor, limit: limit + 1 })
      const rows = yield* store.select(table, query, permission)
      const stored = Array.take(rows, limit)
      const items = yield* decodeRows(stored)
      const last = rows.length > limit ? Array.last(stored) : Option.none<Readonly<Record<string, unknown>>>()

      const nextCursor = yield* Option.match(last, {
        onNone: () => Effect.succeed(null),
        onSome: (row) => renderCursor({ resource: table.name, filter, identifier: row[table.identifier] }),
      })

      return PageSchema.make({ items, nextCursor })
    })

    const find = withAccess("read", findAuthorized)
    const get = withAccess("read", getAuthorized)
    const list = withAccess("read", listAuthorized)
    const create = withAccess("create", createAuthorized)
    const update = withAccess("update", updateAuthorized)
    const patch = withAccess("patch", patchAuthorized)
    const remove = withAccess("remove", removeAuthorized)
    const repository = { find, get, list, create, update, patch, remove }
    const CreateShapeSchema = Schema.Struct(creationPlan.inputFields)
    interface CreateShape extends Schema.Schema.Type<typeof CreateShapeSchema> {}
    const createInputSchema = Schema.make<Schema.Codec<ResourceDraft<S, Creation>, unknown, S["DecodingServices"], S["EncodingServices"]>>(CreateShapeSchema.ast)
    const IdentifierKeySchema = Schema.Literal(table.identifier)
    const IdentifierShapeSchema = Schema.Record(IdentifierKeySchema, canonicalIdentifierSchema)
    const identifierRequestSchema = Schema.make<Schema.Codec<Readonly<Record<CanonicalKey, CanonicalId>>, unknown, S["DecodingServices"], S["EncodingServices"]>>(IdentifierShapeSchema.ast)
    const canonicalRowWireSchema = Schema.toCodecJson(canonicalRowSchema)
    const createWireSchema = Schema.toCodecJson(createInputSchema)
    const identifierWireSchema = Schema.toCodecJson(identifierRequestSchema)
    const rowsWireSchema = Schema.Array(canonicalRowWireSchema)
    const canonicalFilterFields = Record.filter(options.schema.fields, (_schema, field) => Array.contains(filterFields, field))
    const CanonicalFilterSchema = Schema.Struct(Record.map(canonicalFilterFields, Schema.optionalKey)).annotate({ parseOptions: { onExcessProperty: "error" } })
    interface CanonicalFilter extends Schema.Schema.Type<typeof CanonicalFilterSchema> {}
    const OptionalFilterSchema = Schema.optionalKey(CanonicalFilterSchema)
    const ListShapeSchema = Schema.Struct({ filter: OptionalFilterSchema, limit: OptionalLimitSchema, cursor: OptionalCursorSchema })
    interface ListShape extends Schema.Schema.Type<typeof ListShapeSchema> {}
    const listInputSchema = Schema.make<Schema.Codec<ListInput<S, List>, unknown, S["DecodingServices"], S["EncodingServices"]>>(ListShapeSchema.ast)
    const listWireSchema = Schema.toCodecJson(listInputSchema)
    const PageSchema = Schema.Struct({ items: rowsWireSchema, nextCursor: NextCursorSchema })
    interface Page extends Schema.Schema.Type<typeof PageSchema> {}
    const mutableFields = Record.remove(options.schema.fields, table.identifier)
    const optionalPatchFields = Record.map(mutableFields, Schema.optionalKey)
    const patchFields: Readonly<Record<string, Schema.Constraint>> = Record.set(optionalPatchFields, table.identifier, ForbiddenFieldSchema)
    const PatchFieldsSchema = Schema.Struct(patchFields)
    interface PatchFields extends Schema.Schema.Type<typeof PatchFieldsSchema> {}
    const PatchShapeSchema = Schema.Struct({ key: canonicalIdentifierSchema, changes: PatchFieldsSchema })
    interface PatchShape extends Schema.Schema.Type<typeof PatchShapeSchema> {}
    const patchInputSchema = Schema.make<Schema.Codec<Readonly<{ key: CanonicalId; changes: ResourceChanges<S, CanonicalKey> }>, unknown, S["DecodingServices"], S["EncodingServices"]>>(PatchShapeSchema.ast)
    const patchWireSchema = Schema.toCodecJson(patchInputSchema)
    const isPublic = equals(options.authorization._tag, "Public")
    const errorSchema = (isPublic ? PublicResourceErrorSchema : ResourceErrorSchema) as ResourceErrors<Auth>
    const identifierFrom = (input: typeof identifierRequestSchema.Type) => input[table.identifier as CanonicalKey]
    const getHandler = flow(identifierFrom, repository.get)
    const removeHandler = flow(identifierFrom, repository.remove)

    const patchHandler = Effect.fn("Resource.patch")(function* (input: typeof patchInputSchema.Type) {
      return yield* repository.patch(input.key, input.changes)
    })

    const getRpc = Rpc.make(`${options.name}.get`, { payload: identifierWireSchema, success: canonicalRowWireSchema, error: errorSchema })
    const listRpc = Rpc.make(`${options.name}.list`, { payload: listWireSchema, success: PageSchema, error: errorSchema })
    const createRpc = Rpc.make(`${options.name}.create`, { payload: createWireSchema, success: canonicalRowWireSchema, error: errorSchema })
    const updateRpc = Rpc.make(`${options.name}.update`, { payload: canonicalRowWireSchema, success: canonicalRowWireSchema, error: errorSchema })
    const patchRpc = Rpc.make(`${options.name}.patch`, { payload: patchWireSchema, success: canonicalRowWireSchema, error: errorSchema })
    const removeRpc = Rpc.make(`${options.name}.remove`, { payload: identifierWireSchema, success: Schema.Void, error: errorSchema })

    // Bind contract and interpreter together because publication must select both.
    const definitions = new Data.Class({
      get: { rpc: getRpc, handler: getHandler },
      list: { rpc: listRpc, handler: repository.list },
      create: { rpc: createRpc, handler: repository.create },
      update: { rpc: updateRpc, handler: repository.update },
      patch: { rpc: patchRpc, handler: patchHandler },
      remove: { rpc: removeRpc, handler: removeHandler },
    })

    type Operation = PublishedOperation<Operations>
    type SelectedRpc = Extract<typeof definitions[ResourceOperation]["rpc"], { readonly _tag: `${Name}.${Operation}` }>
    const selected = Array.map(operations, (operation) => definitions[operation].rpc) as Array<SelectedRpc>
    const selectedGroup = RpcGroup.make(...selected)
    type PublishedRpc = Auth extends PolicyAuthorization ? Rpc.AddMiddleware<SelectedRpc, typeof AuthorizationRpc> : SelectedRpc
    const isProtected = equals(options.authorization._tag, "Policy")

    const group = (isProtected
      ? selectedGroup.middleware(AuthorizationRpc)
      : selectedGroup) as RpcGroup.Any as RpcGroup.RpcGroup<PublishedRpc>

    const handlerRecord = pipe(
      operations,
      Array.map((operation) => [`${options.name}.${operation}`, definitions[operation].handler] as const),
      Record.fromEntries,
    )

    const handlers = selectedGroup.toLayer(handlerRecord as typeof handlerRecord & RpcGroup.HandlersFrom<SelectedRpc>) as Layer.Layer<
      Rpc.ToHandler<SelectedRpc>,
      never,
      Effect.Services<ReturnType<typeof definitions[Operation]["handler"]>>
    >

    return Struct.assign(options, {
      operations, storage: storageSchema, table, creation: creationPlan.inspection, list: listPolicy, createInputSchema,
      repository: repository as AuthorizedRepository<typeof repository, Auth>, group, handlers,
    })
  },
}
