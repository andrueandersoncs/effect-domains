import { Array, Data, Effect, Function, HashSet, Option, Record, Schema, Tuple, flow, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Command } from "./command.ts"
import { PageLimitSchema, type StructValue } from "./domain.ts"
import { Page } from "./page.ts"
import { RepositoryOrder, RepositorySelect } from "./repository-store.ts"
import { SqliteList } from "./sqlite-list.ts"
import { type CompiledReadModel, type ReadModelSpec } from "./read-model-syntax.ts"
import { type CompiledReadModelFor, compileReadModel, definitionError, ReadModelInputError } from "./read-model-compiler.ts"

class ReadModelPageSpec<
  Model extends ReadModelSpec = ReadModelSpec,
  Filter extends ReadonlyArray<
    Extract<keyof CompiledReadModelFor<Model>["schema"]["fields"], string>
  > = ReadonlyArray<Extract<keyof CompiledReadModelFor<Model>["schema"]["fields"], string>>,
  Range extends ReadonlyArray<
    Extract<keyof CompiledReadModelFor<Model>["schema"]["fields"], string>
  > = ReadonlyArray<Extract<keyof CompiledReadModelFor<Model>["schema"]["fields"], string>>,
  Order extends ReadonlyArray<readonly [
    Extract<keyof CompiledReadModelFor<Model>["schema"]["fields"], string>,
    "asc" | "desc",
  ]> = ReadonlyArray<readonly [
    Extract<keyof CompiledReadModelFor<Model>["schema"]["fields"], string>,
    "asc" | "desc",
  ]>,
> extends Data.Class<{
  readonly model: Model
  readonly filter: Filter
  readonly range: Range
  readonly order: Order
  readonly limit: number
}> {}

const pageReadModel = <
  const Model extends ReadModelSpec,
  const Filter extends ReadonlyArray<
    Extract<keyof CompiledReadModelFor<Model>["schema"]["fields"], string>
  > = readonly [],
  const Range extends ReadonlyArray<
    Extract<keyof CompiledReadModelFor<Model>["schema"]["fields"], string>
  > = readonly [],
  const Order extends ReadonlyArray<readonly [
    Extract<keyof CompiledReadModelFor<Model>["schema"]["fields"], string>,
    "asc" | "desc",
  ]> = ReadonlyArray<readonly [
    Extract<keyof CompiledReadModelFor<Model>["schema"]["fields"], string>,
    "asc" | "desc",
  ]>,
>(definition: Readonly<{
  model: Model
  order: Order
}> & Readonly<Partial<{
  filter: Filter
  range: Range
  limit: number
}>>): ReadModelPageSpec<Model, Filter | readonly [], Range | readonly [], Order> => {
  const filter = definition.filter ?? []
  const range = definition.range ?? []
  const limit = definition.limit ?? 50

  return new ReadModelPageSpec({
    filter,
    limit,
    model: definition.model,
    order: definition.order,
    range,
  })
}


type ViewField<View extends CompiledReadModel> =
  Extract<keyof View["schema"]["Type"], string>

type ViewFilter<
  View extends CompiledReadModel,
  Fields extends ReadonlyArray<ViewField<View>>,
> = Readonly<Partial<Pick<View["schema"]["Type"], Fields[number]>>>

type ViewRange<
  View extends CompiledReadModel,
  Fields extends ReadonlyArray<ViewField<View>>,
> = Readonly<Partial<{
  [Field in Fields[number]]: Readonly<Partial<{
    from: View["schema"]["Type"][Field]
    to: View["schema"]["Type"][Field]
  }>>
}>>

type ViewListRequest<
  View extends CompiledReadModel,
  Filter extends ReadonlyArray<ViewField<View>>,
  Range extends ReadonlyArray<ViewField<View>>,
> = Readonly<Partial<{
  filter: ViewFilter<View, Filter>
  range: ViewRange<View, Range>
  limit: number
  cursor: string
}>>


const invalidList = (reason: string) => ReadModelInputError.make({ reason })

const freezeOrder = <Field extends string>(
  [field, direction]: readonly [Field, "asc" | "desc"],
) => Object.freeze([field, direction] as const)

const orderField = <Field extends string>(entry: readonly [Field, "asc" | "desc"]) =>
  Tuple.get(entry, 0)

const compileReadModelPage = <const Spec extends ReadModelPageSpec>(
  spec: Spec,
) => {
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const view = compileReadModel(spec.model) as PageView<Spec>

  type View = PageView<Spec>
  type Filter = PageFilter<Spec>
  type Range = PageRange<Spec>

  const copiedFilterFields = Array.fromIterable(
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    spec.filter as ReadonlyArray<ViewField<View>>,
  )

  const filterFields = Object.freeze(copiedFilterFields)

  const copiedRangeFields = Array.fromIterable(
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    spec.range as ReadonlyArray<ViewField<View>>,
  )

  const rangeFields = Object.freeze(copiedRangeFields)

  const copiedOrderSource = Array.fromIterable(
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    spec.order as ReadonlyArray<readonly [ViewField<View>, "asc" | "desc"]>,
  )

  const copiedOrder = Array.map(copiedOrderSource, freezeOrder)
  const order = Object.freeze(copiedOrder)
  const validMaximum = Schema.is(PageLimitSchema)(spec.limit)

  if (!validMaximum) pipe(definitionError("list limit must be between 1 and 100"), Effect.runSync)
  if (Array.isReadonlyArrayEmpty(order)) pipe(definitionError("list order must contain at least one field"), Effect.runSync)

  const orderFields = Array.map(order, orderField)
  const filterAndRangeFields = Array.appendAll(filterFields, rangeFields)
  const allFields = Array.appendAll(filterAndRangeFields, orderFields)
  const isMissing = (field: ViewField<View>) => !Record.has(view.projected, field)
  const missing = Array.findFirst(allFields, isMissing)

  if (Option.isSome(missing)) {
    pipe(definitionError(`list field ${missing.value} is not selected by the view`), Effect.runSync)
  }

  const distinctOrderFields = HashSet.fromIterable(orderFields)
  const distinctOrderFieldCount = HashSet.size(distinctOrderFields)
  const duplicateOrder = order.length !== distinctOrderFieldCount

  if (duplicateOrder) pipe(definitionError("list order fields must be unique"), Effect.runSync)

  const rangeAndOrderFields = Array.appendAll(rangeFields, orderFields)

  const isNotOrderable = (field: ViewField<View>) => {
    const projected = pipe(Record.get(view.projected, field), Option.getOrThrow)

    return !projected.orderable
  }

  const notOrderable = Array.findFirst(rangeAndOrderFields, isNotOrderable)

  if (Option.isSome(notOrderable)) {
    pipe(definitionError(`list field ${notOrderable.value} must preserve non-null storage ordering`), Effect.runSync)
  }

  const schemaFor = (field: string) => pipe(
    Record.get(view.schema.fields, field),
    Option.getOrThrow,
  )

  const canonicalField = flow(schemaFor, Schema.toType)

  const repositoryOrderEntry = ([field, direction]: readonly [ViewField<View>, "asc" | "desc"]) =>
    new RepositoryOrder({ field, direction })

  const repositoryOrderEntries = Array.map(order, repositoryOrderEntry)
  const repositoryOrder = Object.freeze(repositoryOrderEntries)

  const cursorScope = JSON.stringify({
    view: view.description,
    filter: filterFields,
    range: rangeFields,
    order,
  })

  const MaximumLimitSchema = PageLimitSchema.check(Schema.isLessThanOrEqualTo(spec.limit))
  const invalidListLimit = (limit: number) => invalidList(`list limit must be between 1 and ${limit}`)
  const invalidListFilter = (field: string) => invalidList(`filter ${field} is not declared`)
  const invalidListRange = (field: string) => invalidList(`range ${field} is not declared`)
  const invalidCursorFailure = invalidList("invalid list cursor")
  const cursorMismatchFailure = invalidList("list cursor does not match the requested filter or range")
  const cursorEncodingFailure = invalidList("could not encode list cursor")
  const invalidListCursor = Function.constant(invalidCursorFailure)
  const listCursorMismatch = Function.constant(cursorMismatchFailure)
  const cursorEncodingError = Function.constant(cursorEncodingFailure)
  const codecError = (cause: Schema.SchemaError) => cause

  const listPlan = SqliteList.make({
    filter: filterFields,
    range: rangeFields,
    order: repositoryOrder,
    maximum: spec.limit,
    scope: cursorScope,
    canonicalField,
    storageField: schemaFor,
    limitSchema: MaximumLimitSchema,
    errors: {
      limit: invalidListLimit,
      filter: invalidListFilter,
      range: invalidListRange,
      invalidCursor: invalidListCursor,
      cursorMismatch: listCursorMismatch,
      codec: codecError,
      cursorEncoding: cursorEncodingError,
    },
  })

  const payloadSchema = Schema.make<Schema.Codec<ViewListRequest<View, Filter, Range>, unknown>>(listPlan.input.ast)
  const CanonicalRowSchema = Schema.toType(view.schema)
  const CanonicalPageSchema = Page.schema(CanonicalRowSchema)

  const successSchema = Schema.make<Schema.Codec<
    Readonly<{ items: ReadonlyArray<View["schema"]["Type"]>; nextCursor: string | null }>,
    typeof CanonicalPageSchema.Encoded,
    typeof CanonicalPageSchema.DecodingServices,
    typeof CanonicalPageSchema.EncodingServices
  >>(CanonicalPageSchema.ast)

  const decodeRows = Schema.decodeUnknownEffect(Schema.Array(view.schema))

  const execute = Effect.fn("ReadModel.page")(function* (
    input: ViewListRequest<View, Filter, Range>,
  ) {
    const sql = yield* SqlClient.SqlClient
    const requestedFilter: RepositorySelect["filter"] = input.filter ?? Record.empty()
    const requestedRange: RepositorySelect["range"] = input.range ?? Record.empty()
    const requestedLimit = Option.fromNullishOr(input.limit)
    const requestedCursor = Option.fromNullishOr(input.cursor)

    const prepared = yield* listPlan.prepare<View["schema"]["EncodingServices"]>(
      requestedFilter,
      requestedRange,
      requestedLimit,
      requestedCursor,
    )

    const column = (field: string) => view.outputField(sql, field)

    const rendered = SqliteList.render(
      sql,
      column,
      prepared.query,
    )

    const rows = yield* sql<StructValue>`
      ${view.select(sql)}
      WHERE ${rendered.where}
      ORDER BY ${rendered.order}
      LIMIT ${prepared.query.limit}
    `

    return yield* listPlan.page(prepared, rows, decodeRows)
  })

  type HandlerRequirements =
    | SqlClient.SqlClient
    | View["schema"]["DecodingServices"]
    | View["schema"]["EncodingServices"]

  const frozenDependencies = Object.freeze([view])

  return Object.freeze({
    payload: payloadSchema,
    success: successSchema,
    errors: ReadModelInputError,
    dependencies: frozenDependencies,
    handler: execute,
  })
}

type PageView<Spec extends ReadModelPageSpec> =
  CompiledReadModelFor<Spec["model"]>

type PageFilter<Spec extends ReadModelPageSpec> =
  Extract<Spec["filter"], ReadonlyArray<ViewField<PageView<Spec>>>>

type PageRange<Spec extends ReadModelPageSpec> =
  Extract<Spec["range"], ReadonlyArray<ViewField<PageView<Spec>>>>

const commandFromPage = <
  const Name extends string,
  const Unavailable extends Schema.Constraint,
  const Page extends ReadModelPageSpec,
>(
  definition: Readonly<{
    name: Name
    unavailable: Unavailable & Readonly<{
      make: (fields: Record<string, never>) => Unavailable["Type"]
    }>
    page: Page
  }>,
) => {
  const {
    dependencies,
    errors: errorsSchema,
    handler,
    payload: payloadSchema,
    success: successSchema,
  } = compileReadModelPage(definition.page)

  const spec = Command.define({
    dependencies,
    errors: errorsSchema,
    name: definition.name,
    payload: payloadSchema,
    success: successSchema,
    unavailable: definition.unavailable,
  })

  return Command.implement(spec, handler)
}

export { commandFromPage, compileReadModelPage, pageReadModel }
