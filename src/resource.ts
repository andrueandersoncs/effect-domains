import { Array, Effect, flow, Layer, Option, Predicate, Record, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import {
  RepositoryError,
  RepositoryStore,
  ResourceNotFound,
  type RepositoryListOrder,
} from "./repository-store.ts"
import { Table, type TableDefinition } from "./table.ts"
import { Value } from "./value.ts"
import { DomainIdentifier } from "./domain.ts"

const EmptyPayloadSchema = Schema.Struct({})
const CursorSchema = Schema.String
const PageLimitSchema = Schema.Int.check(Schema.isGreaterThan(0))

interface EmptyPayload extends Schema.Schema.Type<typeof EmptyPayloadSchema> {}

type ResourceOperation = "get" | "list" | "create" | "update" | "remove" | "patch"
type GeneratedValue = "uuidV7" | "now"
type FieldName<S extends Schema.Struct<Schema.Struct.Fields>> = Extract<keyof S["fields"], string>
type FieldValues<S extends Schema.Struct<Schema.Struct.Fields>> = S["Type"]
type CreationDefaultKeys<Creation> = Creation extends { readonly defaults?: infer Defaults }
  ? Defaults extends object ? Extract<keyof Defaults, string> : never
  : never
type CreationGeneratedKeys<Creation> = Creation extends { readonly generated?: infer Generated }
  ? Generated extends object ? Extract<keyof Generated, string> : never
  : never
type CreateInput<
  S extends Schema.Struct<Schema.Struct.Fields>,
  Creation extends CreationPolicy<S> | undefined,
> = Creation extends CreationPolicy<S>
  ? Omit<FieldValues<S>, CreationDefaultKeys<Creation> | CreationGeneratedKeys<Creation>> &
    Partial<Pick<FieldValues<S>, Extract<CreationDefaultKeys<Creation>, keyof FieldValues<S>>>>
  : FieldValues<S>
type PatchInput<S extends Schema.Struct<Schema.Struct.Fields>, Key extends string> =
  Partial<Omit<FieldValues<S>, Key>>
type ListInput<
  S extends Schema.Struct<Schema.Struct.Fields>,
  Policy extends ListPolicy<S> | undefined,
> = Policy extends ListPolicy<S>
  ? Readonly<{
    filter?: Partial<Pick<FieldValues<S>, Extract<Policy["filter"] extends ReadonlyArray<infer Field> ? Field : never, keyof FieldValues<S>>>>
    limit?: number
    cursor?: string
  }>
  : never
type CompatibleStorage<
  Canonical extends Schema.Struct<Schema.Struct.Fields>,
  Storage extends Schema.Struct<Schema.Struct.Fields>,
> = Storage["Type"] extends Canonical["Type"]
  ? Canonical["Type"] extends Storage["Type"]
    ? unknown
    : never
  : never

export interface CreationPolicy<S extends Schema.Struct<Schema.Struct.Fields>> {
  /** Values inserted only when their field is absent from create input. */
  readonly defaults?: Partial<Pick<FieldValues<S>, FieldName<S>>>
  /** Fields supplied by the runtime and never accepted from callers. */
  readonly generated?: Partial<Record<FieldName<S>, GeneratedValue>>
}

export interface ListOrder<Field extends string> {
  readonly field: Field
  readonly direction?: "asc" | "desc"
}

export interface ListPolicy<S extends Schema.Struct<Schema.Struct.Fields>> {
  /** Canonical fields callers may match exactly. Fields are never inferred. */
  readonly filter?: ReadonlyArray<FieldName<S>>
  /** Declared ordering. The identifier is always appended as a stable tie-breaker. */
  readonly order: ReadonlyArray<ListOrder<FieldName<S>>>
  /** Maximum accepted page size. Defaults to 50. */
  readonly limit?: number
}

type ResourceOptions<
  Name extends string,
  S extends Schema.Struct<Schema.Struct.Fields>,
  Storage extends Schema.Struct<Schema.Struct.Fields>,
  Operations extends ReadonlyArray<ResourceOperation>,
  Creation extends CreationPolicy<S> | undefined,
  List extends ListPolicy<S> | undefined,
> = Readonly<{
  name: Name
  schema: S
  /** A reversible persistence codec whose decoded row is the canonical row. */
  storage?: Storage
  operations: Operations
  create?: Creation
  list?: List
}>

const ResourceErrorSchema = Schema.Union([RepositoryError, ResourceNotFound])
const own = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key)

const resourceFailure = (resource: string, cause: unknown) =>
  RepositoryError.make({ resource, cause })

const invalidInput = (resource: string, reason: string) =>
  resourceFailure(resource, new Error(reason))

const scalarMatches = (field: Table["fields"][number], value: unknown) =>
  (field.scalar === "string" && typeof value === "string") ||
  (field.scalar === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
  (field.scalar === "number" && typeof value === "number" && Number.isFinite(value))

const decodeCursor = (
  resource: string,
  cursor: string,
  order: ReadonlyArray<RepositoryListOrder>,
  filter: Readonly<Record<string, unknown>>,
  fields: ReadonlyArray<Table["fields"][number]>,
  identifierName: string,
) => {
  try {
    const parsed: unknown = JSON.parse(cursor)
    if (
      !Predicate.isObject(parsed) ||
      parsed.resource !== resource ||
      !globalThis.Array.isArray(parsed.values) ||
      !globalThis.Array.isArray(parsed.order) ||
      !Predicate.isObject(parsed.filter) ||
      !("identifier" in parsed) ||
      parsed.values.length !== order.length ||
      JSON.stringify(parsed.order) !== JSON.stringify(order) ||
      JSON.stringify(parsed.filter) !== JSON.stringify(filter)
    ) {
      return Effect.fail(invalidInput(resource, "invalid list cursor"))
    }
    const values = parsed.values as ReadonlyArray<unknown>
    const orderedFields = order.map((entry) => fields.find((field) => field.name === entry.field))
    const identifier = fields.find((field) => field.name === identifierName)
    if (
      orderedFields.some((field, index) => field === undefined || !scalarMatches(field, values[index])) ||
      identifier === undefined ||
      !scalarMatches(identifier, parsed.identifier)
    ) {
      return Effect.fail(invalidInput(resource, "invalid list cursor"))
    }
    return Effect.succeed({ values: parsed.values, identifier: parsed.identifier })
  } catch {
    return Effect.fail(invalidInput(resource, "invalid list cursor"))
  }
}

const encodeCursor = (
  row: Readonly<Record<string, unknown>>,
  resource: string,
  order: ReadonlyArray<RepositoryListOrder>,
  filter: Readonly<Record<string, unknown>>,
  identifier: string,
) =>
  JSON.stringify({
    resource,
    order,
    filter,
    values: order.map((entry) => row[entry.field]),
    identifier: row[identifier],
  })

const makeRepository = <
  Name extends string,
  Storage extends Schema.Struct<Schema.Struct.Fields>,
  Canonical extends Schema.Struct<Schema.Struct.Fields>,
  Key extends string,
  Row extends Schema.Struct<Schema.Struct.Fields>,
  Identifier extends Schema.Constraint,
  Creation extends CreationPolicy<Canonical> | undefined,
  List extends ListPolicy<Canonical> | undefined,
>(
  table: TableDefinition<Name, Storage, Key, Row, Identifier>,
  canonicalRowSchema: Schema.Schema<Row["Type"]>,
  creation: Creation | undefined,
  listPolicy: List | undefined,
) => {
  const repositoryFailure = (cause: Schema.SchemaError) =>
    RepositoryError.make({ resource: table.name, cause })
  const validateCanonical = (value: unknown) =>
    Schema.is(canonicalRowSchema)(value)
      ? Effect.succeed(value)
      : Effect.fail(invalidInput(table.name, "value does not satisfy the canonical schema"))

  const encodeKey = flow(
    Schema.encodeEffect(table.identifierStorageSchema),
    Effect.mapError(repositoryFailure),
  )
  const encodeStorage = flow(
    Schema.encodeEffect(table.storageSchema),
    Effect.mapError(repositoryFailure),
  )
  const encodeRow = flow(
    validateCanonical,
    Effect.flatMap(encodeStorage),
  )
  const decodeRow = flow(
    Schema.decodeUnknownEffect(table.storageSchema),
    Effect.mapError(repositoryFailure),
    Effect.flatMap(validateCanonical),
  )
  const storageRowsSchema = Schema.Array(table.storageSchema)
  const decodeRows = flow(
    Schema.decodeUnknownEffect(storageRowsSchema),
    Effect.mapError(repositoryFailure),
    Effect.flatMap((rows) => Effect.forEach(rows, validateCanonical)),
  )
  const missing = (key: unknown) =>
    ResourceNotFound.make({ resource: table.name, key: String(key) })

  const generated: Record<string, GeneratedValue> = {}
  for (const [field, value] of Object.entries(creation?.generated ?? {})) {
    if (value !== undefined) generated[field] = value
  }
  if (!own(table.schema.fields, table.identifier) && !own(generated, table.identifier)) {
    generated[table.identifier] = "uuidV7"
  }

  const defaults = creation?.defaults ?? {}
  const generatedEntries = Object.entries(generated)
  const create = Effect.fn("Repository.create")(function* (
    input: CreateInput<Canonical, Creation>,
  ) {
    for (const [field] of generatedEntries) {
      if (own(input, field)) {
        return yield* Effect.fail(invalidInput(table.name, `create input must not provide generated field ${field}`))
      }
    }

    const complete: Record<string, unknown> = { ...defaults, ...input }
    if (generatedEntries.length > 0) {
      const values = yield* Value
      for (const [field, generation] of generatedEntries) {
        complete[field] = generation === "uuidV7"
          ? yield* values.uuidV7()
          : yield* values.now()
      }
    }

    const canonical = yield* validateCanonical(complete)
    const encoded = yield* encodeRow(canonical)
    const store = yield* RepositoryStore
    const stored = yield* store.insert(table, encoded)
    return yield* decodeRow(stored)
  })

  const find = Effect.fn("Repository.find")(function* (key: Identifier["Type"]) {
    const encoded = yield* encodeKey(key)
    const store = yield* RepositoryStore
    const stored = yield* store.find(table, encoded)
    if (Option.isNone(stored)) return Option.none<Row["Type"]>()
    return Option.some(yield* decodeRow(stored.value))
  })

  const get = Effect.fn("Repository.get")(function* (key: Identifier["Type"]) {
    const found = yield* find(key)
    if (Option.isNone(found)) return yield* missing(key)
    return found.value
  })

  const list = Effect.fn("Repository.list")(function* () {
    const store = yield* RepositoryStore
    const stored = yield* store.list(table)
    return yield* decodeRows(stored)
  })

  const maximum = listPolicy?.limit ?? 50
  const filterFields = listPolicy?.filter ?? []
  const filterSchema = Schema.Struct(
    Record.fromEntries(filterFields.map((field) => [
      field,
      Schema.optionalKey(table.schema.fields[field] as Schema.Constraint),
    ])),
  ) as unknown as Schema.Codec<
    Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>,
    never, Storage["EncodingServices"]
  >
  const encodeFilter = flow(Schema.encodeUnknownEffect(filterSchema), Effect.mapError(repositoryFailure))
  const order = (listPolicy?.order ?? []).map((entry) => ({
    field: entry.field,
    direction: entry.direction ?? "asc" as const,
  }))

  const page = Effect.fn("Repository.page")(function* (
    input: ListInput<Canonical, List>,
  ) {
    if (listPolicy === undefined) return yield* Effect.fail(invalidInput(table.name, "list policy is not declared"))
    const limit = input.limit ?? maximum
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximum) {
      return yield* Effect.fail(invalidInput(table.name, `list limit must be between 1 and ${maximum}`))
    }

    const requestedFilter = input.filter ?? {}
    for (const field of Object.keys(requestedFilter)) {
      if (!filterFields.includes(field as FieldName<Canonical>)) {
        return yield* Effect.fail(invalidInput(table.name, `filter ${field} is not declared`))
      }
    }
    const filter = yield* encodeFilter(requestedFilter)
    const cursor = input.cursor === undefined
      ? undefined
      : yield* decodeCursor(table.name, input.cursor, order, filter, table.fields, table.identifier)
    const store = yield* RepositoryStore
    const result = yield* store.query(table, { filter, order, cursor, limit })
    const items = yield* decodeRows(result.rows)
    const last = result.rows.at(-1)
    const nextCursor = result.hasMore && last !== undefined
      ? encodeCursor(
        last as Readonly<Record<string, unknown>>,
        table.name,
        order,
        filter,
        table.identifier,
      )
      : null
    return { items, nextCursor }
  })

  const update = Effect.fn("Repository.update")(function* (value: Row["Type"]) {
    const encoded = yield* encodeRow(value)
    const store = yield* RepositoryStore
    const stored = yield* store.update(table, encoded)
    if (Option.isNone(stored)) return yield* missing(encoded[table.identifier])
    return yield* decodeRow(stored.value)
  })

  const patch = Effect.fn("Repository.patch")(function* (
    key: Identifier["Type"],
    changes: PatchInput<Canonical, Key>,
  ) {
    if (own(changes, table.identifier)) {
      return yield* Effect.fail(invalidInput(table.name, `patch must not provide immutable field ${table.identifier}`))
    }
    const encodedKey = yield* encodeKey(key)
    const store = yield* RepositoryStore
    return yield* store.transaction(table, Effect.gen(function* () {
      const stored = yield* store.find(table, encodedKey)
      if (Option.isNone(stored)) return yield* missing(key)
      const current = yield* decodeRow(stored.value)
      const candidate = { ...current, ...changes, [table.identifier]: current[table.identifier] }
      const canonical = yield* validateCanonical(candidate)
      const encoded = yield* encodeRow(canonical)
      const updated = yield* store.update(table, encoded)
      if (Option.isNone(updated)) return yield* missing(key)
      return yield* decodeRow(updated.value)
    }))
  })

  const remove = Effect.fn("Repository.remove")(function* (key: Identifier["Type"]) {
    const encoded = yield* encodeKey(key)
    const store = yield* RepositoryStore
    const removed = yield* store.remove(table, encoded)
    if (!removed) return yield* missing(key)
  })

  return { find, get, list, page, create, update, patch, remove }
}

export class Resource extends Schema.Class<Resource>("Resource")({
  name: Schema.String,
  schema: Schema.Any,
  storage: Schema.Any,
  table: Schema.Any,
  operations: Schema.Array(Schema.Literals(["get", "list", "create", "update", "remove", "patch"])),
  create: Schema.Any,
  list: Schema.Any,
  repository: Schema.Any,
  group: Schema.Any,
  handlers: Schema.Any,
}) {
  static readonly crud = ["get", "list", "create", "update", "remove"] as const

  static override make<
    const Name extends string,
    const S extends Schema.Struct<Schema.Struct.Fields>,
    const Storage extends Schema.Struct<Schema.Struct.Fields> = S,
    const Operations extends ReadonlyArray<ResourceOperation> = ReadonlyArray<ResourceOperation>,
    const Creation extends CreationPolicy<S> | undefined = undefined,
    const List extends ListPolicy<S> | undefined = undefined,
  >(options: ResourceOptions<Name, S, Storage, Operations, Creation, List> & CompatibleStorage<S, Storage>) {
    const storage = (options.storage ?? options.schema) as unknown as Storage
    const table = Table.make({ name: options.name, schema: storage })
    type CanonicalTable = ReturnType<typeof Table.make<Name, S>>
    type CanonicalRow = CanonicalTable["rowSchema"]["Type"]
    type CanonicalKey = CanonicalTable["identifier"]
    type CanonicalId = CanonicalTable["identifierSchema"]["Type"]
    const canonicalFields = options.schema.fields as Readonly<Record<string, Schema.Constraint>>
    const storageFields = storage.fields as Readonly<Record<string, Schema.Constraint>>
    const canonicalNames = Object.keys(canonicalFields).sort()
    const storageNames = Object.keys(storageFields).sort()
    if (canonicalNames.length !== storageNames.length || canonicalNames.some((field, index) => field !== storageNames[index])) {
      throw new Error(`Resource ${options.name} storage fields must match the canonical schema`)
    }
    for (const field of canonicalNames) {
      const canonicalIdentity = Schema.resolveAnnotations(canonicalFields[field]!)?.[DomainIdentifier] === true
      const storageIdentity = Schema.resolveAnnotations(storageFields[field]!)?.[DomainIdentifier] === true
      if (canonicalIdentity !== storageIdentity) {
        throw new Error(`Resource ${options.name} storage must preserve canonical identity on ${field}`)
      }
    }
    for (const field of Object.keys(options.create?.defaults ?? {})) {
      if (!own(canonicalFields, field) || own(options.create?.generated ?? {}, field)) {
        throw new Error(`Resource ${options.name} declares an unknown or generated default field ${field}`)
      }
    }
    for (const field of Object.keys(options.create?.generated ?? {})) {
      if (!own(canonicalFields, field)) {
        throw new Error(`Resource ${options.name} declares unknown generated field ${field}`)
      }
    }
    const canonicalRowSchema = (own(canonicalFields, table.identifier)
      ? options.schema
      : Schema.Struct({
        ...canonicalFields,
        [table.identifier]: table.identifierSchema,
      })) as CanonicalTable["rowSchema"]
    const implicitIdentifier = !own(canonicalFields, table.identifier)
    const generated = {
      ...(options.create?.generated ?? {}),
      ...(implicitIdentifier ? { [table.identifier]: "uuidV7" as const } : {}),
    }
    if (options.list !== undefined) {
      const fields = new Set(table.fields.map((field) => field.name))
      for (const field of options.list.filter ?? []) {
        if (!own(canonicalFields, field) || !fields.has(field)) {
          throw new Error(`Resource ${options.name} declares unknown list filter ${field}`)
        }
      }
      for (const entry of options.list.order) {
        const field = table.fields.find((field) => field.name === entry.field)
        if (
          !own(canonicalFields, entry.field) ||
          field === undefined ||
          field.nullable ||
          canonicalFields[entry.field] !== storageFields[entry.field]
        ) {
          throw new Error(`Resource ${options.name} declares invalid list order ${entry.field}`)
        }
      }
    }
    const repository = makeRepository<
      Name,
      Storage,
      S,
      typeof table.identifier,
      typeof table.rowSchema,
      typeof table.identifierSchema,
      Creation,
      List
    >(
      table,
      canonicalRowSchema as Schema.Schema<typeof table.rowSchema.Type>,
      options.create,
      options.list,
    )

    const createFields = Record.fromEntries([
      ...Object.entries(canonicalFields).map(([field, fieldSchema]) => {
        if (own(generated, field)) return [field, Schema.optionalKey(Schema.Never)] as const
        const optional = own(options.create?.defaults ?? {}, field)
        return [field, optional ? Schema.optionalKey(fieldSchema) : fieldSchema] as const
      }),
      ...(implicitIdentifier ? [[table.identifier, Schema.optionalKey(Schema.Never)] as const] : []),
    ])
    const createInputSchema = Schema.Struct(createFields) as unknown as Schema.Codec<
      CreateInput<S, Creation>, unknown, S["DecodingServices"], S["EncodingServices"]
    >
    const canonicalIdentifierSchema = (own(canonicalFields, table.identifier)
      ? canonicalFields[table.identifier]
      : table.identifierSchema) as CanonicalTable["identifierSchema"]
    const identifierRequestSchema = Schema.Record(
      Schema.Literal(table.identifier),
      canonicalIdentifierSchema,
    )
    const canonicalRowWireSchema = Schema.toCodecJson(canonicalRowSchema)
    const createWireSchema = Schema.toCodecJson(createInputSchema)
    const identifierWireSchema = Schema.toCodecJson(identifierRequestSchema)
    const rowsWireSchema = Schema.Array(canonicalRowWireSchema)

    const listFields = (options.list === undefined
      ? EmptyPayloadSchema
      : Schema.Struct({
        filter: Schema.optionalKey(Schema.Struct(Record.fromEntries(
          (options.list.filter ?? []).map((field) => [
            field,
            Schema.optionalKey(canonicalFields[field] as Schema.Constraint),
          ]),
        ))),
        limit: Schema.optionalKey(PageLimitSchema),
        cursor: Schema.optionalKey(CursorSchema),
      })) as unknown as Schema.Codec<
        List extends ListPolicy<S> ? ListInput<S, List> : {},
        unknown, S["DecodingServices"], S["EncodingServices"]
      >
    const listWireSchema = options.list === undefined
      ? EmptyPayloadSchema
      : Schema.toCodecJson(listFields)
    const listSuccessSchema = (options.list === undefined
      ? rowsWireSchema
      : Schema.Struct({ items: rowsWireSchema, nextCursor: Schema.NullOr(CursorSchema) })) as unknown as Schema.Codec<
        List extends ListPolicy<S>
          ? { readonly items: ReadonlyArray<CanonicalRow>; readonly nextCursor: string | null }
          : ReadonlyArray<CanonicalRow>,
        unknown, S["DecodingServices"], S["EncodingServices"]
      >
    const patchSchema = Schema.Struct({
      [table.identifier]: canonicalIdentifierSchema,
      patch: Schema.Struct(Record.fromEntries([
        ...Object.entries(canonicalFields)
          .filter(([field]) => field !== table.identifier)
          .map(([field, schema]) => [field, Schema.optionalKey(schema)] as const),
        [table.identifier, Schema.optionalKey(Schema.Never)] as const,
      ])),
    }) as Schema.Codec<
      Readonly<Record<CanonicalKey, CanonicalId>> & { readonly patch: PatchInput<S, CanonicalKey> },
      unknown, S["DecodingServices"], S["EncodingServices"]
    >

    const getProcedure = Rpc.make(`${options.name}.get`, { payload: identifierWireSchema, success: canonicalRowWireSchema, error: ResourceErrorSchema })
    const listProcedure = Rpc.make(`${options.name}.list`, { payload: listWireSchema, success: listSuccessSchema, error: ResourceErrorSchema })
    const createProcedure = Rpc.make(`${options.name}.create`, { payload: createWireSchema, success: canonicalRowWireSchema, error: ResourceErrorSchema })
    const updateProcedure = Rpc.make(`${options.name}.update`, { payload: canonicalRowWireSchema, success: canonicalRowWireSchema, error: ResourceErrorSchema })
    const patchProcedure = Rpc.make(`${options.name}.patch`, { payload: Schema.toCodecJson(patchSchema), success: canonicalRowWireSchema, error: ResourceErrorSchema })
    const removeProcedure = Rpc.make(`${options.name}.remove`, { payload: identifierWireSchema, success: Schema.Void, error: ResourceErrorSchema })

    const identifierFrom = (input: typeof identifierRequestSchema.Type) => input[table.identifier]
    const getHandler = flow(identifierFrom, repository.get)
    const removeHandler = flow(identifierFrom, repository.remove)
    const listHandler = (options.list === undefined ? repository.list : repository.page) as
      List extends ListPolicy<S> ? typeof repository.page : typeof repository.list
    const patchHandler = (input: unknown) => {
      const request = input as Readonly<Record<string, unknown>> & { readonly patch: PatchInput<S, typeof table.identifier> }
      return repository.patch(
        request[table.identifier] as typeof table.identifierSchema.Type,
        request.patch,
      )
    }
    const procedureFor = (operation: Operations[number]) => ({ get: getProcedure, list: listProcedure, create: createProcedure, update: updateProcedure, patch: patchProcedure, remove: removeProcedure })[operation]
    const handlerByOperation = { get: getHandler, list: listHandler, create: repository.create, update: repository.update, patch: patchHandler, remove: removeHandler }
    const handlerFor = <Operation extends Operations[number]>(operation: Operation) => handlerByOperation[operation]
    const tagFor = (operation: Operations[number]) => `${options.name}.${operation}`
    const selected = Array.map(options.operations, procedureFor)
    const group = RpcGroup.make(...selected) as RpcGroup.RpcGroup<ReturnType<typeof procedureFor>>
    type GeneratedHandlerRecord = {
      readonly [Operation in Operations[number] as `${Name}.${Operation}`]: typeof handlerByOperation[Operation]
    }
    const handlerRecord = Record.fromEntries(
      Array.map(options.operations, (operation) => [tagFor(operation), handlerFor(operation)] as const),
    ) as GeneratedHandlerRecord
    const handlers = group.toLayer(
      handlerRecord as unknown as RpcGroup.HandlersFrom<ReturnType<typeof procedureFor>>,
    ) as Layer.Layer<
      Rpc.ToHandler<ReturnType<typeof procedureFor>>,
      never,
      Effect.Services<ReturnType<typeof handlerByOperation[Operations[number]]>>
    >

    return super.make({
      name: options.name,
      schema: options.schema,
      storage,
      table,
      operations: options.operations,
      create: options.create,
      list: options.list,
      repository,
      group,
      handlers,
    }) as Struct.Assign<Resource, {
      name: Name
      schema: S
      storage: Storage
      table: typeof table
      operations: Operations
      repository: typeof repository
      group: typeof group
      create: Creation | undefined
      list: List | undefined
      handlers: typeof handlers
    }>
  }
}
