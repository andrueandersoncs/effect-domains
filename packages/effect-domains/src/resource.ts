import { Array, Effect, Equivalence, flow, Function, Layer, Option, Order, Predicate, Record, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { RepositoryAccess, RepositoryError, RepositoryListCursor, RepositoryListOrder, RepositoryListQuery, RepositoryStore, ResourceNotFound } from "./repository-store.ts"
import { Table, type TableField, withImplicitIdentifier } from "./table.ts"
import { Value } from "./value.ts"
import type { AnyCommandBundle } from "./commands.ts"
import { DomainIdentifier } from "./domain.ts"
import { Authorization, AuthorizationValues, Forbidden, Unauthenticated, type AuthorizationAction, type AuthorizationDefinition, type PolicyAuthorization, type SubjectOperand } from "./authorization.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"

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

type CreationDefaultKeys<Creation> = Creation extends { readonly defaults: infer Defaults }
  ? Extract<keyof Defaults, string> : never

type CreationGeneratedKeys<Creation> = Creation extends { readonly generated: infer Generated }
  ? Extract<keyof Generated, string> : never

type CreationSubjectKeys<Creation> = Creation extends { readonly fromSubject: infer Bindings }
  ? Extract<keyof Bindings, string> : never

type SubjectBindings<S extends Schema.Struct<Schema.Struct.Fields>, Auth> =
  Auth extends PolicyAuthorization
    ? Readonly<Partial<{ readonly [Key in Extract<keyof S["fields"], string>]: SubjectOperand<S["Type"][Key]> }>>
    : never

type CreationPolicy<S extends Schema.Struct<Schema.Struct.Fields>, Auth = PolicyAuthorization> = Readonly<Partial<{
  defaults: Partial<Pick<S["Type"], Extract<keyof S["fields"], string>>>
  generated: Partial<Record<Extract<keyof S["fields"], string>, "uuidV7" | "now">>
  fromSubject: SubjectBindings<S, Auth>
}>>

type ListPolicy<S extends Schema.Struct<Schema.Struct.Fields>> = Readonly<{
  order: ReadonlyArray<Readonly<{ field: Extract<keyof S["fields"], string> }> & Readonly<Partial<{ direction: "asc" | "desc" }>>>
}> & Readonly<Partial<{
  filter: ReadonlyArray<Extract<keyof S["fields"], string>>
  limit: number
}>>

type CreateInput<S extends Schema.Struct<Schema.Struct.Fields>, Creation> =
  Omit<S["Type"], CreationDefaultKeys<Creation> | CreationGeneratedKeys<Creation> | CreationSubjectKeys<Creation>> &
  Partial<Pick<S["Type"], Extract<CreationDefaultKeys<Creation>, keyof S["Type"]>>>

type PatchInput<S extends Schema.Struct<Schema.Struct.Fields>, Key extends string> = Partial<Omit<S["Type"], Key>>

type ListInput<S extends Schema.Struct<Schema.Struct.Fields>, Policy extends ListPolicy<S>> = Readonly<Partial<{
  filter: Partial<Pick<S["Type"], Extract<Policy["filter"] extends ReadonlyArray<infer Field> ? Field : never, keyof S["Type"]>>>
  limit: number
  cursor: string
}>>

type CompatibleStorage<Canonical extends Schema.Struct<Schema.Struct.Fields>, Storage extends Schema.Struct<Schema.Struct.Fields>> =
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
const tableScalarEquals = Equivalence.strictEqual<TableField["scalar"]>()
const absentAuthorizationValue = Option.none<Readonly<Record<string, unknown>>>()

const scalarMatches = (field: TableField, value: unknown) => {
  const stringField = tableScalarEquals(field.scalar, "string")
  const integerField = tableScalarEquals(field.scalar, "integer")
  const numberField = tableScalarEquals(field.scalar, "number")
  const text = stringField && Predicate.isString(value)
  const integer = integerField && Number.isSafeInteger(value)
  const number = numberField && Number.isFinite(value)
  const numeric = integer || number
  return text || numeric
}

const identityAnnotation = (schema: Schema.Constraint) => {
  const annotations = Schema.resolveAnnotations(schema)
  return equals(annotations?.[DomainIdentifier], true)
}

const fieldNamed = (name: string) => (field: TableField) =>
  equals(field.name, name)

export interface Resource extends AnyCommandBundle {
  readonly name: string
  readonly schema: Schema.Struct<Schema.Struct.Fields>
  readonly storage: Schema.Struct<Schema.Struct.Fields>
  readonly table: Table
  readonly operations: ReadonlyArray<ResourceOperation>
  readonly authorization: AuthorizationDefinition
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
    const Auth extends AuthorizationDefinition = AuthorizationDefinition,
    const Creation extends CreationPolicy<S, Auth> = {},
    const List extends ListPolicy<S> = never,
  >(options: Readonly<{ name: Name; schema: S; operations: Operations; authorization: Auth }> & Readonly<Partial<{
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
    const subjectBindings: Readonly<Record<string, SubjectOperand<unknown>>> = options.create?.fromSubject ?? Record.empty()
    const presentSubjectBindings = pipe(subjectBindings, Record.map(Option.fromNullishOr), Record.getSomes)
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
      const subjectBindingNames = Record.keys(subjectBindings)

      yield* Effect.forEach(subjectBindingNames, (field) => {
        const canonical = Record.has(options.schema.fields, field)

        if (!canonical) {
          return definitionFailure(`declares an unknown, defaulted, or generated create subject binding ${field}`)
        }

        const defaulted = Record.has(defaults, field)
        const generated = Record.has(declaredGenerated, field)
        const overlaps = defaulted || generated

        return overlaps
          ? definitionFailure(`declares an unknown, defaulted, or generated create subject binding ${field}`)
          : Effect.void
      })

      yield* pipe(
        Authorization.validateSubjectBindings(options.authorization, options.schema, subjectBindings),
        Effect.mapError(({ reason }) => definitionFailure(reason)),
      )

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
        const column = Record.get(table.columns, entry.field)
        const preservesOrder = Option.exists(column, Struct.get("orderable"))
        const compatible = required && same
        const ordered = compatible && preservesOrder
        const valid = declared && ordered
        return valid ? Effect.void : definitionFailure(`declares invalid list order ${entry.field}`)
      })
    })

    Effect.runSync(validateDefinition)
    const implicitIdentifier = !Record.has(options.schema.fields, table.identifier)

    const generated = implicitIdentifier
      ? Record.set(declaredGenerated, table.identifier, "uuidV7" as const)
      : declaredGenerated

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

    const access = (subject: Readonly<Record<string, unknown>>) =>
      RepositoryAccess.make({
        policy: authorization.visibility,
        subject,
      })

    const authorize = (
      action: AuthorizationAction,
      subject: Readonly<Record<string, unknown>>,
      values: AuthorizationValues,
    ) => pipe(
      authorization.check(action, subject, values),
      Effect.catchTag("PolicyEvaluationError", () => RepositoryError.make({ resource: table.name, cause: "Authorization evaluation failed" })),
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
    const subjectBindingEntries = Record.toEntries(presentSubjectBindings)

    const create = Effect.fn("Repository.create")(function* (input: CreateInput<S, Creation>) {
      yield* Effect.forEach(generatedEntries, ([field]) => Record.has(input, field)
        ? inputFailure(`create input must not provide generated field ${field}`) : Effect.void)

      yield* Effect.forEach(subjectBindingEntries, ([field]) => Record.has(input, field)
        ? inputFailure(`create input must not provide subject-bound field ${field}`) : Effect.void)

      const subject = yield* authorization.subject("create")

      const subjectValues = Array.map(subjectBindingEntries, ([target, binding]) =>
        [target, subject[binding.field]] as const)

      const generate = Effect.fn("Repository.generate")(function* ([field, generation]: [string, "uuidV7" | "now"]) {
        const values = yield* Value
        const uuid = equals(generation, "uuidV7")
        const value = uuid ? yield* values.uuidV7() : yield* values.now()
        return [field, value] as const
      })

      const generatedValues = yield* Effect.forEach(generatedEntries, generate)
      const generatedRecord = Record.fromEntries(generatedValues)
      const subjectRecord = Record.fromEntries(subjectValues)
      const supplied = Struct.assign(defaults, input)
      const bound = Struct.assign(supplied, subjectRecord)
      const complete = Struct.assign(bound, generatedRecord)
      const encoded = yield* encodeRow(complete)
      const store = yield* RepositoryStore

      const transaction = Effect.gen(function* () {
        const next = Option.some(complete)

        const candidate = AuthorizationValues.make({
          row: absentAuthorizationValue,
          next,
        })

        yield* authorize("create", subject, candidate)
        const stored = yield* store.insert(table, encoded)
        const result = yield* decodeRow(stored)
        const row = Option.some(result)

        const returned = AuthorizationValues.make({
          row,
          next: absentAuthorizationValue,
        })

        yield* authorize("read", subject, returned)
        return result
      })

      return yield* store.transaction(table, transaction)
    })

    const find = Effect.fn("Repository.find")(function* (key: CanonicalId) {
      const subject = yield* authorization.subject("read")
      const encoded = yield* encodeKey(key)
      const store = yield* RepositoryStore
      const permission = access(subject)
      const stored = yield* store.find(table, encoded, permission)
      if (Option.isNone(stored)) return Option.none<CanonicalRow>()
      return yield* pipe(decodeRow(stored.value), Effect.map(Option.some))
    })

    const get = Effect.fn("Repository.get")(function* (key: CanonicalId) {
      const found = yield* find(key)
      if (Option.isNone(found)) return yield* missing(key)
      return found.value
    })

    const list = Effect.fn("Repository.list")(function* () {
      const subject = yield* authorization.subject("read")
      const store = yield* RepositoryStore
      const permission = access(subject)
      const stored = yield* store.list(table, permission)
      return yield* decodeRows(stored)
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
      const subject = yield* authorization.subject("read")
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
      const emptyCursor = Option.none<RepositoryListCursor>()

      const cursor = yield* Option.match(cursorInput, {
        onNone: () => Effect.succeed(emptyCursor),
        onSome: Effect.fn("Repository.cursor")(function* (source: string) {
          const decoded = yield* pipe(parseCursor(source), Effect.mapError(Function.constant(cursorFailure)))
          const sameResource = equals(decoded.resource, table.name)
          const actualOrder = JSON.stringify(decoded.order)
          const actualFilter = JSON.stringify(decoded.filter)
          const sameOrder = equals(actualOrder, expectedOrder)
          const sameFilter = equals(actualFilter, expectedFilter)
          const sameLength = equals(decoded.values.length, order.length)
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

          const cursorValue = RepositoryListCursor.make({
            values: decoded.values,
            identifier: decoded.identifier,
          })

          return Option.some(cursorValue)
        }),
      })

      const query = RepositoryListQuery.make({ filter, order, cursor, limit })
      const store = yield* RepositoryStore
      const permission = access(subject)
      const result = yield* store.query(table, query, permission)
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

    const replaceExisting = Effect.fn("Repository.replaceExisting")(function* <R>(
      action: Extract<AuthorizationAction, "update" | "patch">,
      subject: Readonly<Record<string, unknown>>,
      key: unknown,
      encodedKey: unknown,
      prepareCandidate: (current: CanonicalRow) => Effect.Effect<readonly [CanonicalRow, Readonly<Record<string, unknown>>], RepositoryError, R>,
    ) {
      const store = yield* RepositoryStore
      const permission = access(subject)

      const transaction = Effect.gen(function* () {
        const stored = yield* store.find(table, encodedKey, permission)
        if (Option.isNone(stored)) return yield* missing(key)
        const current = yield* decodeRow(stored.value)
        const [candidate, encoded] = yield* prepareCandidate(current)
        const currentRow = Option.some(current)
        const candidateNext = Option.some(candidate)

        const changed = AuthorizationValues.make({
          row: currentRow,
          next: candidateNext,
        })

        yield* authorize(action, subject, changed)
        const updated = yield* store.update(table, encoded, permission)
        if (Option.isNone(updated)) return yield* missing(key)
        const result = yield* decodeRow(updated.value)
        const resultRow = Option.some(result)

        const readable = AuthorizationValues.make({
          row: resultRow,
          next: absentAuthorizationValue,
        })

        yield* authorize("read", subject, readable)
        return result
      })

      return yield* store.transaction(table, transaction)
    })

    const update = Effect.fn("Repository.update")(function* (value: CanonicalRow) {
      const subject = yield* authorization.subject("update")
      const encoded = yield* encodeRow(value)
      const key = encoded[table.identifier]
      const retained = Effect.succeed([value, encoded] as const)
      const prepareCandidate = Function.constant(retained)
      return yield* replaceExisting("update", subject, key, key, prepareCandidate)
    })

    const patch = Effect.fn("Repository.patch")(function* (key: CanonicalId, changes: PatchInput<S, CanonicalKey>) {
      const subject = yield* authorization.subject("patch")
      if (Record.has(changes, table.identifier)) return yield* inputFailure(`patch must not provide immutable field ${table.identifier}`)
      const encodedKey = yield* encodeKey(key)

      const prepareCandidate = Effect.fn("Repository.patch.candidate")(function* (current: CanonicalRow) {
        const candidate = Struct.assign(current, changes)
        const encoded = yield* encodeRow(candidate)
        return [candidate, encoded] as const
      })

      return yield* replaceExisting("patch", subject, key, encodedKey, prepareCandidate)
    })

    const remove = Effect.fn("Repository.remove")(function* (key: CanonicalId) {
      const subject = yield* authorization.subject("remove")
      const encoded = yield* encodeKey(key)
      const store = yield* RepositoryStore
      const permission = access(subject)

      const transaction = Effect.gen(function* () {
        const stored = yield* store.find(table, encoded, permission)
        if (Option.isNone(stored)) return yield* missing(key)
        const current = yield* decodeRow(stored.value)
        const currentRow = Option.some(current)

        const target = AuthorizationValues.make({
          row: currentRow,
          next: absentAuthorizationValue,
        })

        yield* authorize("remove", subject, target)
        const removed = yield* store.remove(table, encoded, permission)
        if (!removed) return yield* missing(key)
      })

      return yield* store.transaction(table, transaction)
    })

    const repository = { find, get, list, page, create, update, patch, remove }

    const createField = (fieldSchema: Schema.Constraint, field: string) => {
      const generatedField = Record.has(generated, field)
      const subjectBoundField = Record.has(subjectBindings, field)
      const forbidden = generatedField || subjectBoundField
      if (forbidden) return ForbiddenFieldSchema
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
    const PatchShapeSchema = Schema.Struct({ key: canonicalIdentifierSchema, changes: PatchFieldsSchema })
    interface PatchShape extends Schema.Schema.Type<typeof PatchShapeSchema> {}
    const patchInputSchema = Schema.make<Schema.Codec<Readonly<{ key: CanonicalId; changes: PatchInput<S, CanonicalKey> }>, unknown, S["DecodingServices"], S["EncodingServices"]>>(PatchShapeSchema.ast)
    const patchWireSchema = Schema.toCodecJson(patchInputSchema)
    const isPublic = equals(options.authorization._tag, "Public")
    const errorSchema = (isPublic ? PublicResourceErrorSchema : ResourceErrorSchema) as ResourceErrors<Auth>
    const getProcedure = Rpc.make(`${options.name}.get`, { payload: identifierWireSchema, success: canonicalRowWireSchema, error: errorSchema })
    const listProcedure = Rpc.make(`${options.name}.list`, { payload: listWireSchema, success: listSuccessSchema, error: errorSchema })
    const createProcedure = Rpc.make(`${options.name}.create`, { payload: createWireSchema, success: canonicalRowWireSchema, error: errorSchema })
    const updateProcedure = Rpc.make(`${options.name}.update`, { payload: canonicalRowWireSchema, success: canonicalRowWireSchema, error: errorSchema })
    const patchProcedure = Rpc.make(`${options.name}.patch`, { payload: patchWireSchema, success: canonicalRowWireSchema, error: errorSchema })
    const removeProcedure = Rpc.make(`${options.name}.remove`, { payload: identifierWireSchema, success: Schema.Void, error: errorSchema })
    const identifierFrom = (input: typeof identifierRequestSchema.Type) => input[table.identifier as CanonicalKey]
    const getHandler = flow(identifierFrom, repository.get)
    const removeHandler = flow(identifierFrom, repository.remove)
    const listHandler = Option.isNone(listPolicy) ? repository.list : repository.page

    const patchHandler = Effect.fn("Resource.patch")(function* (input: typeof patchInputSchema.Type) {
      return yield* repository.patch(input.key, input.changes)
    })

    const procedures = [getProcedure, listProcedure, createProcedure, updateProcedure, patchProcedure, removeProcedure]
    const handlerByOperation = { get: getHandler, list: listHandler, create: repository.create, update: repository.update, patch: patchHandler, remove: removeHandler }
    type SelectedRpc = Extract<typeof procedures[number], { readonly _tag: `${Name}.${Operations[number]}` }>

    const selectProcedure = (operation: Operations[number]) => {
      const tag = `${options.name}.${operation}`

      const isSelected = (procedure: typeof procedures[number]): procedure is SelectedRpc =>
        equals(procedure._tag, tag)

      const selected = Array.findFirst(procedures, isSelected)

      return Option.match(selected, {
        onNone: () => definitionFailure(`declares unknown operation ${operation}`),
        onSome: Effect.succeed,
      })
    }

    const selected = pipe(options.operations, Effect.forEach(selectProcedure), Effect.runSync)
    const selectedGroup = RpcGroup.make(...selected)
    type PublishedRpc = Auth extends PolicyAuthorization ? Rpc.AddMiddleware<SelectedRpc, typeof AuthorizationRpc> : SelectedRpc
    const isProtected = equals(options.authorization._tag, "Policy")

    const group = (isProtected
      ? selectedGroup.middleware(AuthorizationRpc)
      : selectedGroup) as RpcGroup.Any as RpcGroup.RpcGroup<PublishedRpc>

    const handlerEntry = (operation: Operations[number]) => [`${options.name}.${operation}`, handlerByOperation[operation]] as const
    const handlerRecord = pipe(options.operations, Array.map(handlerEntry), Record.fromEntries)

    const handlers = selectedGroup.toLayer(handlerRecord as typeof handlerRecord & RpcGroup.HandlersFrom<SelectedRpc>) as Layer.Layer<
      Rpc.ToHandler<SelectedRpc>,
      never,
      Effect.Services<ReturnType<typeof handlerByOperation[Operations[number]]>>
    >

    return Struct.assign(options, {
      storage: storageSchema, table, create: creation, list: listPolicy, createInputSchema,
      repository: repository as AuthorizedRepository<typeof repository, Auth>, group, handlers,
    })
  },
}
