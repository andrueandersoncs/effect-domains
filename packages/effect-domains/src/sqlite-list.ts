import { Array, Effect, Equivalence, Function, HashSet, Option, Predicate, Record, Schema, pipe } from "effect"
import { SqlClient, Statement } from "effect/unstable/sql"
import { Page } from "./page.ts"
import { RepositoryOrder, RepositorySelect } from "./repository-store.ts"

type StoredFilter = RepositorySelect["filter"]
type StoredRange = RepositorySelect["range"]

interface ListErrors<InputError, CodecError, CursorError> {
  readonly limit: (maximum: number) => InputError
  readonly filter: (field: string) => InputError
  readonly range: (field: string) => InputError
  readonly invalidCursor: () => InputError
  readonly cursorMismatch: () => InputError
  readonly codec: (cause: Schema.SchemaError) => CodecError
  readonly cursorEncoding: (cause: Schema.SchemaError) => CursorError
}

interface ListDefinition<InputError, CodecError, CursorError> {
  readonly filter: ReadonlyArray<string>
  readonly range: ReadonlyArray<string>
  readonly order: ReadonlyArray<RepositoryOrder>
  readonly maximum: number
  readonly scope: string
  readonly canonicalField: (field: string) => Schema.Constraint
  readonly storageField: (field: string) => Schema.Constraint
  readonly limitSchema: Schema.Constraint
  readonly errors: ListErrors<InputError, CodecError, CursorError>
}

type PreparedSqliteList = Readonly<{
  query: RepositorySelect
  pageSize: number
}>

const StoredFilterSchema = Schema.Record(Schema.String, Schema.Unknown)

const StoredRangeBoundsSchema = Schema.Struct({
  from: Schema.optionalKey(Schema.Unknown),
  to: Schema.optionalKey(Schema.Unknown),
})

const StoredRangeSchema = Schema.Record(Schema.String, StoredRangeBoundsSchema)
const unknownEquals = Equivalence.strictEqual<unknown>()

const directionEquals = Equivalence.strictEqual<"asc" | "desc">()

const optionalFieldEntry = (schema: (field: string) => Schema.Constraint) => (field: string) =>
  [field, Schema.optionalKey(schema(field))] as const

const optionalRangeEntry = (schema: (field: string) => Schema.Constraint) => (field: string) =>
  [field, Schema.optionalKey(Schema.Struct({
    from: Schema.optionalKey(schema(field)),
    to: Schema.optionalKey(schema(field)),
  }))] as const

const make = <InputError, CodecError, CursorError>(
  definition: ListDefinition<InputError, CodecError, CursorError>,
) => {
  const canonicalFilterEntries = Array.map(definition.filter, optionalFieldEntry(definition.canonicalField))
  const canonicalFilterFields = Record.fromEntries(canonicalFilterEntries)
  const canonicalRangeEntries = Array.map(definition.range, optionalRangeEntry(definition.canonicalField))
  const canonicalRangeFields = Record.fromEntries(canonicalRangeEntries)
  const storageFilterEntries = Array.map(definition.filter, optionalFieldEntry(definition.storageField))
  const storageFilterFields = Record.fromEntries(storageFilterEntries)
  const storageRangeEntries = Array.map(definition.range, optionalRangeEntry(definition.storageField))
  const storageRangeFields = Record.fromEntries(storageRangeEntries)
  const cursorEntry = ({ field }: RepositoryOrder) => [field, Schema.toEncoded(definition.storageField(field))] as const
  const cursorEntries = Array.map(definition.order, cursorEntry)
  const cursorFields = Record.fromEntries(cursorEntries)
  const rejectExcess = { parseOptions: { onExcessProperty: "error" as const } }
  const CanonicalFilterSchema = Schema.Struct(canonicalFilterFields).annotate(rejectExcess)
  const CanonicalRangeSchema = Schema.Struct(canonicalRangeFields).annotate(rejectExcess)
  const StorageFilterSchema = Schema.Struct(storageFilterFields)
  const StorageRangeSchema = Schema.Struct(storageRangeFields)
  const CursorAfterSchema = Schema.Struct(cursorFields)
  const limitBounds = Schema.isBetween({ minimum: 1, maximum: definition.maximum })
  const MaximumLimitSchema = Schema.Int.check(limitBounds)

  const InputSchema = Schema.Struct({
    filter: Schema.optionalKey(CanonicalFilterSchema),
    range: Schema.optionalKey(CanonicalRangeSchema),
    limit: Schema.optionalKey(definition.limitSchema),
    cursor: Schema.optionalKey(Schema.String),
  }).annotate({ parseOptions: { onExcessProperty: "error" } })

  const encodeFilter = Schema.encodeUnknownEffect(StorageFilterSchema)
  const encodeRange = Schema.encodeUnknownEffect(StorageRangeSchema)
  const decodeStoredFilter = Schema.decodeUnknownEffect(StoredFilterSchema)
  const decodeStoredRange = Schema.decodeUnknownEffect(StoredRangeSchema)
  const isLimit = Schema.is(MaximumLimitSchema)
  const cursor = Page.cursor(definition.scope, CursorAfterSchema)
  const filterFields = HashSet.fromIterable(definition.filter)
  const rangeFields = HashSet.fromIterable(definition.range)
  const noAfter = Option.none<StoredFilter>()
  const noAfterEffect = Effect.succeed(noAfter)

  const validateFilter = (field: string) => {
    if (HashSet.has(filterFields, field)) return Effect.void

    const error = definition.errors.filter(field)

    return Effect.fail(error)
  }

  const validateRange = (field: string) => {
    if (HashSet.has(rangeFields, field)) return Effect.void

    const error = definition.errors.range(field)

    return Effect.fail(error)
  }

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const prepare = Effect.fn("SqliteList.prepare")(function* (
    requestedFilter: StoredFilter,
    requestedRange: StoredRange,
    requestedLimit: Option.Option<number>,
    cursorInput: Option.Option<string>,
  ) {
    const limit = Option.getOrElse(requestedLimit, Function.constant(definition.maximum))

    if (!isLimit(limit)) {
      const error = definition.errors.limit(definition.maximum)

      return yield* Effect.fail(error)
    }

    const requestedFilterFields = Record.keys(requestedFilter)
    const requestedRangeFields = Record.keys(requestedRange)

    yield* Effect.forEach(requestedFilterFields, validateFilter, { discard: true })
    yield* Effect.forEach(requestedRangeFields, validateRange, { discard: true })

    const filter = yield* pipe(
      encodeFilter(requestedFilter),
      Effect.flatMap(decodeStoredFilter),
      Effect.mapError(definition.errors.codec),
    )

    const range = yield* pipe(
      encodeRange(requestedRange),
      Effect.flatMap(decodeStoredRange),
      Effect.mapError(definition.errors.codec),
    )

    const expectedFilter = JSON.stringify(filter)
    const expectedRange = JSON.stringify(range)

    const decodeCursor = Effect.fn("SqliteList.cursor")(function* (source: string) {
      const state = yield* pipe(
        cursor.parse(source),
        Effect.mapError(() => definition.errors.invalidCursor()),
      )

      const actualFilter = JSON.stringify(state.filter)
      const actualRange = JSON.stringify(state.range)
      const filterMatches = Equivalence.strictEqual<string>()(actualFilter, expectedFilter)
      const rangeMatches = Equivalence.strictEqual<string>()(actualRange, expectedRange)
      const filterMismatch = !filterMatches
      const rangeMismatch = !rangeMatches
      const mismatch = filterMismatch || rangeMismatch

      if (mismatch) {
        const error = definition.errors.cursorMismatch()

        return yield* Effect.fail(error)
      }

      return Option.some(state.after)
    })

    const after = yield* Option.match(cursorInput, {
      onNone: Function.constant(noAfterEffect),
      onSome: decodeCursor,
    })

    return {
      query: new RepositorySelect({
        filter,
        range,
        order: definition.order,
        after,
        limit: limit + 1,
      }),
      pageSize: limit,
    }
  }) as <EncodingServices>(
    filter: StoredFilter,
    range: StoredRange,
    limit: Option.Option<number>,
    cursor: Option.Option<string>,
  ) => Effect.Effect<PreparedSqliteList, InputError | CodecError, EncodingServices>

  const page = Effect.fn("SqliteList.page")(function* <Value, DecodeError, DecodeServices>(
    prepared: PreparedSqliteList,
    rows: ReadonlyArray<StoredFilter>,
    decode: (rows: ReadonlyArray<StoredFilter>) => Effect.Effect<ReadonlyArray<Value>, DecodeError, DecodeServices>,
  ) {
    const stored = Array.take(rows, prepared.pageSize)
    const items = yield* decode(stored)

    if (rows.length <= prepared.pageSize) return { items, nextCursor: null }

    const lastOption = Array.last(stored)
    const last = Option.getOrThrow(lastOption)
    const afterEntry = ({ field }: RepositoryOrder) => [field, last[field]] as const
    const afterEntries = Array.map(definition.order, afterEntry)
    const after = Record.fromEntries(afterEntries)

    const nextCursor = yield* pipe(
      cursor.render({ filter: prepared.query.filter, range: prepared.query.range, after }),
      Effect.mapError(definition.errors.cursorEncoding),
    )

    return { items, nextCursor }
  })

  return Object.freeze({ input: InputSchema, prepare, page })
}

type Column = (field: string) => Statement.Identifier | Statement.Fragment

const equalityClause = (
  sql: SqlClient.SqlClient,
  column: Column,
) => ([field, value]: readonly [string, unknown]) => unknownEquals(value, null)
  ? sql`${column(field)} IS NULL`
  : sql`${column(field)} = ${value}`


const keysetPrevious = (
  sql: SqlClient.SqlClient,
  column: Column,
  after: StoredFilter,
) => ({ field }: RepositoryOrder) => unknownEquals(after[field], null)
  ? sql`${column(field)} IS NULL`
  : sql`${column(field)} = ${after[field]}`

const keysetComparison = (
  sql: SqlClient.SqlClient,
  column: Column,
  after: StoredFilter,
) => (entry: RepositoryOrder) => {
  const value = after[entry.field]
  const nullValue = unknownEquals(value, null)
  const ascending = directionEquals(entry.direction, "asc")

  if (nullValue) {
    return ascending
      ? sql`${column(entry.field)} IS NOT NULL`
      : sql.literal("1 = 0")
  }

  return ascending
    ? sql`${column(entry.field)} > ${value}`
    : sql`${column(entry.field)} < ${value}`
}

const keysetFragment = (
  sql: SqlClient.SqlClient,
  column: Column,
  order: ReadonlyArray<RepositoryOrder>,
  after: StoredFilter,
) => {
  const previousClause = keysetPrevious(sql, column, after)
  const comparisonClause = keysetComparison(sql, column, after)

  const clause = (entry: RepositoryOrder, index: number) => {
    const previous = Array.take(order, index)
    const equalities = Array.map(previous, previousClause)
    const comparison = comparisonClause(entry)
    const conditions = Array.append(equalities, comparison)

    return sql.and(conditions)
  }

  const clauses = Array.map(order, clause)

  return sql.or(clauses)
}

const render = (
  sql: SqlClient.SqlClient,
  column: Column,
  query: RepositorySelect,
  additionalPredicates: ReadonlyArray<Statement.Fragment> = [],
) => {
  const filterEntries = Record.toEntries(query.filter)
  const renderEquality = equalityClause(sql, column)
  const filters = Array.map(filterEntries, renderEquality)
  const rangeEntries = Record.toEntries(query.range)

  const renderBounds = ([field, bounds]: readonly [string, StoredRange[string]]) => {
    const hasFrom = Predicate.hasProperty(bounds, "from")
    const hasTo = Predicate.hasProperty(bounds, "to")
    const lower = hasFrom ? Option.some(sql`${column(field)} >= ${bounds.from}`) : Option.none()
    const upper = hasTo ? Option.some(sql`${column(field)} <= ${bounds.to}`) : Option.none()

    return Array.getSomes([lower, upper])
  }

  const ranges = Array.flatMap(rangeEntries, renderBounds)
  const predicates = [...filters, ...ranges, ...additionalPredicates]

  const withAfter = (after: StoredFilter) => {
    const keyset = keysetFragment(sql, column, query.order, after)

    return Array.append(predicates, keyset)
  }

  const conditions = Option.match(query.after, {
    onNone: Function.constant(predicates),
    onSome: withAfter,
  })

  const noConditions = Array.isReadonlyArrayEmpty(conditions)
  const where = noConditions ? sql.literal("1 = 1") : sql.and(conditions)

  const orderClause = ({ field, direction }: RepositoryOrder) => {
    const ascending = directionEquals(direction, "asc")
    const keyword = ascending ? "ASC" : "DESC"

    return sql`${column(field)} ${sql.literal(keyword)}`
  }

  const orderClauses = Array.map(query.order, orderClause)
  const order = sql.csv(orderClauses)

  return { where, order }
}

export const SqliteList = { make, render }
