import { Array, Effect, Equivalence, flow, Function, Layer, Option, Order, Predicate, Record, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { RepositoryError, RepositoryListCursor, RepositoryListOrder, RepositoryListQuery, RepositoryStore, ResourceNotFound } from "./repository-store.ts"
import { Table, type TableField } from "./table.ts"
import { Value } from "./value.ts"
import type { AnyCommandBundle } from "./commands.ts"
import { DomainIdentifier } from "./domain.ts"

const EmptyPayloadSchema = Schema.Struct({})
interface EmptyPayload extends Schema.Schema.Type<typeof EmptyPayloadSchema> {}
const PositiveLimitCheck = Schema.isGreaterThan(0)
const PageLimitSchema = Schema.Int.check(PositiveLimitCheck)
const OptionalLimitSchema = Schema.optionalKey(PageLimitSchema)
const OptionalCursorSchema = Schema.optionalKey(Schema.String)
const ForbiddenFieldSchema = Schema.optionalKey(Schema.Never)
const NextCursorSchema = Schema.NullOr(Schema.String)
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const CursorOrdersSchema = Schema.Array(RepositoryListOrder)
const CursorValuesSchema = Schema.Array(Schema.Unknown)

class ListCursor extends Schema.Class<ListCursor>("ListCursor")({
  resource: Schema.String,
  order: CursorOrdersSchema,
  filter: UnknownRecordSchema,
  values: CursorValuesSchema,
  identifier: Schema.Unknown,
}) {}

const ListCursorJsonSchema = Schema.fromJsonString(ListCursor)
const parseCursor = Schema.decodeUnknownEffect(ListCursorJsonSchema)

type ResourceOperation = "get" | "list" | "create" | "update" | "remove" | "patch"
type FieldName<S extends Schema.Struct<Schema.Struct.Fields>> = Extract<keyof S["fields"], string>

type CreationDefaultKeys<Creation> = Creation extends { readonly defaults: infer Defaults }
  ? Extract<keyof Defaults, string> : never

type CreationGeneratedKeys<Creation> = Creation extends { readonly generated: infer Generated }
  ? Extract<keyof Generated, string> : never

type CreationPolicy<S extends Schema.Struct<Schema.Struct.Fields>> = Readonly<Partial<{
  defaults: Partial<Pick<S["Type"], FieldName<S>>>
  generated: Partial<Record<FieldName<S>, "uuidV7" | "now">>
}>>

type ListPolicy<S extends Schema.Struct<Schema.Struct.Fields>> = Readonly<{
  order: ReadonlyArray<Readonly<{ field: FieldName<S> }> & Readonly<Partial<{ direction: "asc" | "desc" }>>>
}> & Readonly<Partial<{
  filter: ReadonlyArray<FieldName<S>>
  limit: number
}>>

type CreateInput<S extends Schema.Struct<Schema.Struct.Fields>, Creation> =
  Omit<S["Type"], CreationDefaultKeys<Creation> | CreationGeneratedKeys<Creation>> &
  Partial<Pick<S["Type"], Extract<CreationDefaultKeys<Creation>, keyof S["Type"]>>>

type PatchInput<S extends Schema.Struct<Schema.Struct.Fields>, Key extends string> = Partial<Omit<S["Type"], Key>>

type ListInput<S extends Schema.Struct<Schema.Struct.Fields>, Policy extends ListPolicy<S>> = Readonly<Partial<{
  filter: Partial<Pick<S["Type"], Extract<Policy["filter"] extends ReadonlyArray<infer Field> ? Field : never, keyof S["Type"]>>>
  limit: number
  cursor: string
}>>

type CompatibleStorage<Canonical extends Schema.Struct<Schema.Struct.Fields>, Storage extends Schema.Struct<Schema.Struct.Fields>> =
  Storage["Type"] extends Canonical["Type"] ? Canonical["Type"] extends Storage["Type"] ? unknown : never : never

const ResourceErrorSchema = Schema.Union([RepositoryError, ResourceNotFound])

class ResourceDefinitionError extends Schema.TaggedError<ResourceDefinitionError>()(
  "ResourceDefinitionError",
  { resource: Schema.String, reason: Schema.String },
) {}

const invalidInput = (resource: string, reason: string) => {
  const cause = ResourceDefinitionError.make({ resource, reason })
  return RepositoryError.make({ resource, cause })
}

const scalarMatches = (field: TableField, value: unknown) => {
  const stringField = Equivalence.strictEqual<TableField["scalar"]>()(field.scalar, "string")
  const integerField = Equivalence.strictEqual<TableField["scalar"]>()(field.scalar, "integer")
  const numberField = Equivalence.strictEqual<TableField["scalar"]>()(field.scalar, "number")
  const text = stringField && Predicate.isString(value)
  const integer = integerField && Number.isSafeInteger(value)
  const number = numberField && Number.isFinite(value)
  const numeric = integer || number
  return text || numeric
}

const identityAnnotation = (schema: Schema.Constraint) => {
  const annotations = Schema.resolveAnnotations(schema)
  return Equivalence.strictEqual<unknown>()(annotations?.[DomainIdentifier], true)
}

const fieldNamed = (name: string) => (field: TableField) =>
  Equivalence.strictEqual<string>()(field.name, name)

export interface Resource extends AnyCommandBundle {
  readonly name: string
  readonly schema: Schema.Struct<Schema.Struct.Fields>
  readonly storage: Schema.Struct<Schema.Struct.Fields>
  readonly table: Table
  readonly operations: ReadonlyArray<ResourceOperation>
  readonly create: Option.Option<CreationPolicy<Schema.Struct<Schema.Struct.Fields>>>
  readonly list: Option.Option<ListPolicy<Schema.Struct<Schema.Struct.Fields>>>
}

export const Resource = {
  crud: ["get", "list", "create", "update", "remove"] as const,

  make<
    const Name extends string,
    const S extends Schema.Struct<Schema.Struct.Fields>,
    const Storage extends Schema.Struct<Schema.Struct.Fields> = S,
    const Operations extends ReadonlyArray<ResourceOperation> = ReadonlyArray<ResourceOperation>,
    const Creation extends CreationPolicy<S> = {},
    const List extends ListPolicy<S> = never,
  >(options: Readonly<{ name: Name; schema: S; operations: Operations }> & Readonly<Partial<{
    storage: Storage
    create: Creation
    list: List
  }>> & CompatibleStorage<S, Storage>) {
    type CanonicalTable = ReturnType<typeof Table.make<Name, S>>
    type CanonicalRow = CanonicalTable["rowSchema"]["Type"]
    type CanonicalKey = CanonicalTable["identifier"]
    type CanonicalId = CanonicalTable["identifierSchema"]["Type"]
    const storageSchema = options.storage ?? options.schema
    const table = Table.make({ name: options.name, schema: storageSchema })
    const creation = Option.fromNullishOr(options.create)
    const listPolicy = Option.fromNullishOr(options.list)
    const defaults: Readonly<Record<string, unknown>> = options.create?.defaults ?? Record.empty()
    const declaredGenerated: Readonly<Record<string, "uuidV7" | "now">> = options.create?.generated ?? Record.empty()
    const canonicalNames = pipe(options.schema.fields, Record.keys, Array.sort(Order.String))
    const storageNames = pipe(storageSchema.fields, Record.keys, Array.sort(Order.String))
    const filterFields: ReadonlyArray<string> = options.list?.filter ?? []
    const declaredOrder = options.list?.order ?? []
    const maximum = options.list?.limit ?? 50
    const definitionFailure = (reason: string) => ResourceDefinitionError.make({ resource: options.name, reason })
    const inputFailure = (reason: string) => invalidInput(options.name, reason)

    const validateDefinition = Effect.gen(function* () {
      const sameFields = Equivalence.Array(Equivalence.strictEqual<string>())(canonicalNames, storageNames)
      if (!sameFields) return yield* definitionFailure("storage fields must match the canonical schema")

      yield* Effect.forEach(canonicalNames, (field) => {
        const canonicalIdentity = pipe(Record.get(options.schema.fields, field), Option.map(identityAnnotation))
        const storageIdentity = pipe(Record.get(storageSchema.fields, field), Option.map(identityAnnotation))
        const equal = Option.makeEquivalence(Equivalence.strictEqual<boolean>())(canonicalIdentity, storageIdentity)
        return equal ? Effect.void : definitionFailure(`storage must preserve canonical identity on ${field}`)
      })

      const defaultNames = Record.keys(defaults)

      yield* Effect.forEach(defaultNames, (field) => {
        const canonical = Record.has(options.schema.fields, field)
        const generated = Record.has(declaredGenerated, field)
        const authored = !generated
        const valid = canonical && authored
        return valid ? Effect.void : definitionFailure(`declares an unknown or generated default field ${field}`)
      })

      const generatedNames = Record.keys(declaredGenerated)

      const validateGeneratedField = (field: string) => Record.has(options.schema.fields, field)
        ? Effect.void : definitionFailure(`declares unknown generated field ${field}`)

      yield* Effect.forEach(generatedNames, validateGeneratedField)

      yield* Effect.forEach(filterFields, (field) => {
        const canonical = Record.has(options.schema.fields, field)
        const physical = Array.some(table.fields, fieldNamed(field))
        const valid = canonical && physical
        return valid ? Effect.void : definitionFailure(`declares unknown list filter ${field}`)
      })

      yield* Effect.forEach(declaredOrder, (entry) => {
        const physical = Array.findFirst(table.fields, fieldNamed(entry.field))
        const required = Option.exists(physical, (field) => !field.nullable)
        const canonical = Record.get(options.schema.fields, entry.field)
        const stored = Record.get(storageSchema.fields, entry.field)
        const same = Option.makeEquivalence(Equivalence.strictEqual<Schema.Constraint>())(canonical, stored)
        const declared = Record.has(options.schema.fields, entry.field)
        const ordered = required && same
        const valid = declared && ordered
        return valid ? Effect.void : definitionFailure(`declares invalid list order ${entry.field}`)
      })
    })

    Effect.runSync(validateDefinition)
    const implicitIdentifier = !Record.has(options.schema.fields, table.identifier)

    const generated = implicitIdentifier
      ? Record.set(declaredGenerated, table.identifier, "uuidV7" as const)
      : declaredGenerated

    const canonicalRowFields = implicitIdentifier
      ? Record.set(options.schema.fields, table.identifier, table.identifierSchema)
      : options.schema.fields

    const CanonicalShapeSchema = Schema.Struct(canonicalRowFields)
    interface CanonicalShape extends Schema.Schema.Type<typeof CanonicalShapeSchema> {}

    const canonicalRowSchema = implicitIdentifier
      ? Schema.make<Schema.Codec<CanonicalRow, unknown, S["DecodingServices"], S["EncodingServices"]>>(CanonicalShapeSchema.ast)
      : Schema.make<Schema.Codec<CanonicalRow, unknown, S["DecodingServices"], S["EncodingServices"]>>(options.schema.ast)

    const canonicalIdentifierSchema = pipe(
      Record.get(options.schema.fields, table.identifier),
      Option.getOrElse(Function.constant(table.identifierSchema)),
    )

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
    const generatedEntries = Record.toEntries(generated)

    const create = Effect.fn("Repository.create")(function* (input: CreateInput<S, Creation>) {
      yield* Effect.forEach(generatedEntries, ([field]) => Record.has(input, field)
        ? inputFailure(`create input must not provide generated field ${field}`) : Effect.void)

      const generate = Effect.fn("Repository.generate")(function* ([field, generation]: [string, "uuidV7" | "now"]) {
        const values = yield* Value
        const uuid = Equivalence.strictEqual<string>()(generation, "uuidV7")
        const value = uuid ? yield* values.uuidV7() : yield* values.now()
        return [field, value] as const
      })

      const generatedValues = yield* Effect.forEach(generatedEntries, generate)
      const generatedRecord = Record.fromEntries(generatedValues)
      const supplied = Struct.assign(defaults, input)
      const complete = Struct.assign(supplied, generatedRecord)
      const encoded = yield* encodeRow(complete)
      const store = yield* RepositoryStore
      const stored = yield* store.insert(table, encoded)
      return yield* decodeRow(stored)
    })

    const find = Effect.fn("Repository.find")(function* (key: CanonicalId) {
      const encoded = yield* encodeKey(key)
      const store = yield* RepositoryStore
      const stored = yield* store.find(table, encoded)
      if (Option.isNone(stored)) return Option.none<CanonicalRow>()
      return yield* pipe(decodeRow(stored.value), Effect.map(Option.some))
    })

    const get = Effect.fn("Repository.get")(function* (key: CanonicalId) {
      const found = yield* find(key)
      if (Option.isNone(found)) return yield* missing(key)
      return found.value
    })

    const list = Effect.fn("Repository.list")(function* () {
      const store = yield* RepositoryStore
      const stored = yield* store.list(table)
      return yield* decodeRows(stored)
    })

    const optionalFieldEntry = (field: string) => {
      const schema = pipe(Record.get(storageSchema.fields, field), Option.map(Schema.optionalKey))
      return [field, schema] as const
    }

    const filterEntries = Array.map(filterFields, optionalFieldEntry)
    const presentFilterFields: Readonly<Record<string, Schema.Constraint>> = pipe(filterEntries, Record.fromEntries, Record.getSomes)
    const FilterSchema = Schema.Struct(presentFilterFields)
    interface Filter extends Schema.Schema.Type<typeof FilterSchema> {}
    const filterCodecSchema = Schema.make<Schema.Codec<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>, never, Storage["EncodingServices"]>>(FilterSchema.ast)
    const encodeFilter = flow(Schema.encodeUnknownEffect(filterCodecSchema), Effect.mapError(repositoryFailure))

    const orderEntry = (entry: typeof declaredOrder[number]) => RepositoryListOrder.make({
      field: entry.field,
      direction: entry.direction ?? "asc",
    })

    const order = Array.map(declaredOrder, orderEntry)
    const cursorFailure = inputFailure("invalid list cursor")
    const expectedOrder = JSON.stringify(order)

    const matchesField = (name: string, value: unknown) => {
      const field = Array.findFirst(table.fields, fieldNamed(name))
      return Option.exists(field, (entry) => scalarMatches(entry, value))
    }

    const page = Effect.fn("Repository.page")(function* (input: ListInput<S, List>) {
      if (Option.isNone(listPolicy)) return yield* inputFailure("list policy is not declared")
      const limit = input.limit ?? maximum
      const integer = Number.isSafeInteger(limit)
      const positive = limit > 0
      const bounded = limit <= maximum
      const validLimit = integer && positive
      const permittedLimit = validLimit && bounded
      if (!permittedLimit) return yield* inputFailure(`list limit must be between 1 and ${maximum}`)
      const requestedFilter = input.filter ?? Record.empty()
      const requestedNames = Record.keys(requestedFilter)

      const validateFilter = (field: string) => Array.contains(filterFields, field)
        ? Effect.void : inputFailure(`filter ${field} is not declared`)

      yield* Effect.forEach(requestedNames, validateFilter)

      const filter = yield* encodeFilter(requestedFilter)
      const cursorInput = Option.fromNullishOr(input.cursor)
      const expectedFilter = JSON.stringify(filter)

      const cursor = yield* Option.match(cursorInput, {
        onNone: () => pipe(Option.none<RepositoryListCursor>(), Effect.succeed),
        onSome: Effect.fn("Repository.cursor")(function* (source: string) {
          const decoded = yield* pipe(parseCursor(source), Effect.mapError(Function.constant(cursorFailure)))
          const sameResource = Equivalence.strictEqual<string>()(decoded.resource, table.name)
          const actualOrder = JSON.stringify(decoded.order)
          const actualFilter = JSON.stringify(decoded.filter)
          const sameOrder = Equivalence.strictEqual<string>()(actualOrder, expectedOrder)
          const sameFilter = Equivalence.strictEqual<string>()(actualFilter, expectedFilter)
          const sameLength = Equivalence.strictEqual<number>()(decoded.values.length, order.length)
          const sameQuery = sameResource && sameOrder
          const sameShape = sameFilter && sameLength
          const same = sameQuery && sameShape
          if (!same) return yield* cursorFailure

          const validValues = Array.every(order, (entry, index) => {
            const value = Array.get(decoded.values, index)
            return Option.exists(value, (item) => matchesField(entry.field, item))
          })

          const validIdentifier = matchesField(table.identifier, decoded.identifier)
          const valid = validValues && validIdentifier
          if (!valid) return yield* cursorFailure
          return pipe(RepositoryListCursor.make(decoded), Option.some)
        }),
      })

      const query = RepositoryListQuery.make({ filter, order, cursor, limit })
      const store = yield* RepositoryStore
      const result = yield* store.query(table, query)
      const items = yield* decodeRows(result.rows)

      const nextCursor = result.hasMore ? pipe(
        Array.last(result.rows),
        Option.map((row) => {
          const values = Array.map(order, (entry) => row[entry.field])
          const encoded = ListCursor.make({ resource: table.name, order, filter, values, identifier: row[table.identifier] })
          return JSON.stringify(encoded)
        }),
        Option.getOrNull,
      ) : null

      return { items, nextCursor }
    })

    const update = Effect.fn("Repository.update")(function* (value: CanonicalRow) {
      const encoded = yield* encodeRow(value)
      const store = yield* RepositoryStore
      const stored = yield* store.update(table, encoded)
      if (Option.isNone(stored)) return yield* missing(encoded[table.identifier])
      return yield* decodeRow(stored.value)
    })

    const patch = Effect.fn("Repository.patch")(function* (key: CanonicalId, changes: PatchInput<S, CanonicalKey>) {
      if (Record.has(changes, table.identifier)) return yield* inputFailure(`patch must not provide immutable field ${table.identifier}`)
      const encodedKey = yield* encodeKey(key)
      const store = yield* RepositoryStore

      const transaction = Effect.gen(function* () {
        const stored = yield* store.find(table, encodedKey)
        if (Option.isNone(stored)) return yield* missing(key)
        const current = yield* decodeRow(stored.value)
        const candidate = Struct.assign(current, changes)
        const encoded = yield* encodeRow(candidate)
        const updated = yield* store.update(table, encoded)
        if (Option.isNone(updated)) return yield* missing(key)
        return yield* decodeRow(updated.value)
      })

      return yield* store.transaction(table, transaction)
    })

    const remove = Effect.fn("Repository.remove")(function* (key: CanonicalId) {
      const encoded = yield* encodeKey(key)
      const store = yield* RepositoryStore
      const removed = yield* store.remove(table, encoded)
      if (!removed) return yield* missing(key)
    })

    const repository = { find, get, list, page, create, update, patch, remove }

    const createField = (fieldSchema: Schema.Constraint, field: string) => {
      if (Record.has(generated, field)) return ForbiddenFieldSchema
      return Record.has(defaults, field) ? Schema.optionalKey(fieldSchema) : fieldSchema
    }

    const declaredCreateFields = Record.map(options.schema.fields, createField)

    const createFields = implicitIdentifier
      ? Record.set(declaredCreateFields, table.identifier, ForbiddenFieldSchema)
      : declaredCreateFields

    const CreateShapeSchema = Schema.Struct(createFields)
    interface CreateShape extends Schema.Schema.Type<typeof CreateShapeSchema> {}
    const createInputSchema = Schema.make<Schema.Codec<CreateInput<S, Creation>, unknown, S["DecodingServices"], S["EncodingServices"]>>(CreateShapeSchema.ast)
    const IdentifierKeySchema = Schema.Literal(table.identifier)
    const IdentifierShapeSchema = Schema.Record(IdentifierKeySchema, canonicalIdentifierSchema)
    const identifierRequestSchema = Schema.make<Schema.Codec<Readonly<Record<CanonicalKey, CanonicalId>>, unknown, S["DecodingServices"], S["EncodingServices"]>>(IdentifierShapeSchema.ast)
    const canonicalRowWireSchema = Schema.toCodecJson(canonicalRowSchema)
    const createWireSchema = Schema.toCodecJson(createInputSchema)
    const identifierWireSchema = Schema.toCodecJson(identifierRequestSchema)
    const rowsWireSchema = Schema.Array(canonicalRowWireSchema)
    const canonicalFilterFields = Record.filter(options.schema.fields, (_schema, field) => Array.contains(filterFields, field))
    const CanonicalFilterSchema = Schema.Struct(Record.map(canonicalFilterFields, Schema.optionalKey))
    interface CanonicalFilter extends Schema.Schema.Type<typeof CanonicalFilterSchema> {}
    const OptionalFilterSchema = Schema.optionalKey(CanonicalFilterSchema)
    const ListShapeSchema = Schema.Struct({ filter: OptionalFilterSchema, limit: OptionalLimitSchema, cursor: OptionalCursorSchema })
    interface ListShape extends Schema.Schema.Type<typeof ListShapeSchema> {}
    const listInputSchema = Schema.make<Schema.Codec<ListInput<S, List>, unknown, S["DecodingServices"], S["EncodingServices"]>>(ListShapeSchema.ast)
    const listWireSchema = Option.isNone(listPolicy) ? EmptyPayloadSchema : Schema.toCodecJson(listInputSchema)
    const PageSchema = Schema.Struct({ items: rowsWireSchema, nextCursor: NextCursorSchema })
    interface Page extends Schema.Schema.Type<typeof PageSchema> {}
    const listSuccessSchema = Option.isNone(listPolicy) ? rowsWireSchema : PageSchema
    const mutableFields = Record.remove(options.schema.fields, table.identifier)
    const optionalPatchFields = Record.map(mutableFields, Schema.optionalKey)
    const patchFields: Readonly<Record<string, Schema.Constraint>> = Record.set(optionalPatchFields, table.identifier, ForbiddenFieldSchema)
    const PatchFieldsSchema = Schema.Struct(patchFields)
    interface PatchFields extends Schema.Schema.Type<typeof PatchFieldsSchema> {}
    const identifierFields = Record.singleton(table.identifier, canonicalIdentifierSchema)
    const patchPayloadFields: Readonly<Record<string, Schema.Constraint>> = Record.set(identifierFields, "patch", PatchFieldsSchema)
    const PatchShapeSchema = Schema.Struct(patchPayloadFields)
    interface PatchShape extends Schema.Schema.Type<typeof PatchShapeSchema> {}
    const patchInputSchema = Schema.make<Schema.Codec<Readonly<Record<CanonicalKey, CanonicalId>> & { readonly patch: PatchInput<S, CanonicalKey> }, unknown, S["DecodingServices"], S["EncodingServices"]>>(PatchShapeSchema.ast)
    const patchWireSchema = Schema.toCodecJson(patchInputSchema)
    const getProcedure = Rpc.make(`${options.name}.get`, { payload: identifierWireSchema, success: canonicalRowWireSchema, error: ResourceErrorSchema })
    const listProcedure = Rpc.make(`${options.name}.list`, { payload: listWireSchema, success: listSuccessSchema, error: ResourceErrorSchema })
    const createProcedure = Rpc.make(`${options.name}.create`, { payload: createWireSchema, success: canonicalRowWireSchema, error: ResourceErrorSchema })
    const updateProcedure = Rpc.make(`${options.name}.update`, { payload: canonicalRowWireSchema, success: canonicalRowWireSchema, error: ResourceErrorSchema })
    const patchProcedure = Rpc.make(`${options.name}.patch`, { payload: patchWireSchema, success: canonicalRowWireSchema, error: ResourceErrorSchema })
    const removeProcedure = Rpc.make(`${options.name}.remove`, { payload: identifierWireSchema, success: Schema.Void, error: ResourceErrorSchema })
    const identifierFrom = (input: typeof identifierRequestSchema.Type) => input[table.identifier as CanonicalKey]
    const getHandler = flow(identifierFrom, repository.get)
    const removeHandler = flow(identifierFrom, repository.remove)
    const listHandler = Option.isNone(listPolicy) ? repository.list : repository.page

    const patchHandler = Effect.fn("Resource.patch")(function* (input: typeof patchInputSchema.Type) {
      return yield* repository.patch(input[table.identifier as CanonicalKey], input.patch)
    })

    const procedures = [getProcedure, listProcedure, createProcedure, updateProcedure, patchProcedure, removeProcedure]
    const handlerByOperation = { get: getHandler, list: listHandler, create: repository.create, update: repository.update, patch: patchHandler, remove: removeHandler }
    type SelectedRpc = Extract<typeof procedures[number], { readonly _tag: `${Name}.${Operations[number]}` }>

    const selectProcedure = (operation: Operations[number]) => {
      const tag = `${options.name}.${operation}`

      const isSelected = (procedure: typeof procedures[number]): procedure is SelectedRpc =>
        Equivalence.strictEqual<string>()(procedure._tag, tag)

      const selected = Array.findFirst(procedures, isSelected)
      return Option.match(selected, {
        onNone: () => definitionFailure(`declares unknown operation ${operation}`),
        onSome: Effect.succeed,
      })
    }

    const selected = pipe(options.operations, Effect.forEach(selectProcedure), Effect.runSync)
    const group = RpcGroup.make(...selected)
    const handlerEntry = (operation: Operations[number]) => [`${options.name}.${operation}`, handlerByOperation[operation]] as const
    const handlerRecord = pipe(options.operations, Array.map(handlerEntry), Record.fromEntries)

    const handlers = group.toLayer(handlerRecord as typeof handlerRecord & RpcGroup.HandlersFrom<SelectedRpc>) as Layer.Layer<
      Rpc.ToHandler<SelectedRpc>,
      never,
      Effect.Services<ReturnType<typeof handlerByOperation[Operations[number]]>>
    >

    return Struct.assign(options, { storage: storageSchema, table, create: creation, list: listPolicy, createInputSchema, repository, group, handlers })
  },
}
