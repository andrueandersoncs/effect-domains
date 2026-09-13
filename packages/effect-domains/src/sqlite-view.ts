import { Array, Effect, Equivalence, Function, HashSet, Match, Option, Record, Schema, SchemaAST, Struct, Tuple, flow, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { PageLimitSchema } from "./domain.ts"
import { Page } from "./page.ts"
import { Operation } from "./operation.ts"
import { quoteIdentifier } from "./sqlite-ddl.ts"
import { TableField, type Table } from "./table.ts"
import { ScalarSchema, type ScalarF } from "./schema-algebra.ts"

const NameSchema = Schema.NonEmptyString.check(Schema.isPattern(/\S/))
const ReferenceSchema = Schema.Tuple([NameSchema, NameSchema])
const ConditionSchema = Schema.Struct({ left: ReferenceSchema, right: ReferenceSchema })
const JoinSchema = Schema.Struct({ kind: Schema.Literals(["inner", "left"]), table: NameSchema, on: Schema.Array(ConditionSchema) })
const SelectionSchema = Schema.Record(NameSchema, ReferenceSchema)

export const SqliteViewDescriptionSchema = Schema.Struct({
  tables: Schema.Record(NameSchema, NameSchema),
  from: NameSchema,
  joins: Schema.Array(JoinSchema),
  select: SelectionSchema,
}).annotate({ parseOptions: { onExcessProperty: "error" } })

interface Description extends Schema.Schema.Type<typeof SqliteViewDescriptionSchema> {}
interface Join extends Schema.Schema.Type<typeof JoinSchema> {}
interface Condition extends Schema.Schema.Type<typeof ConditionSchema> {}
type Reference = Schema.Schema.Type<typeof ReferenceSchema>
type Tables = Readonly<Record<string, Table>>
type Alias<Sources extends Tables> = Extract<keyof Sources, string>

const ColumnEvidenceSchema = Schema.Struct({
  storageSchema: Schema.declare<Schema.Constraint>(Schema.isSchema),
  orderable: Schema.Boolean,
})

const TableEvidenceSchema = Schema.Struct({
  name: NameSchema,
  fields: Schema.Array(TableField),
  columns: Schema.Record(Schema.String, ColumnEvidenceSchema),
})


const DefinitionSchema = Schema.Struct({
  ...SqliteViewDescriptionSchema.fields,
  tables: Schema.Record(NameSchema, Schema.Unknown),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

type Definition = Omit<Description, "tables"> & { readonly tables: Tables }

type ReferenceFor<Sources extends Tables> = {
  [Key in Alias<Sources>]: readonly [Key, Extract<keyof Sources[Key]["rowSchema"]["fields"], string>]
}[Alias<Sources>]

type JoinFor<Sources extends Tables> = {
  readonly [Key in keyof Join]: Key extends "table" ? Alias<Sources>
    : Key extends "on" ? ReadonlyArray<{ readonly [Field in keyof Condition]: ReferenceFor<Sources> }>
    : Join[Key]
}

type SelectionFor<Sources extends Tables> = Readonly<Record<string, ReferenceFor<Sources>>>
type LeftAlias<Joins> = Joins extends ReadonlyArray<infer Entry> ? Entry extends { readonly kind: "left"; readonly table: infer Key } ? Key : never : never

 type SelectedField<Sources extends Tables, Ref extends ReferenceFor<Sources>> =
  Ref extends readonly [infer Key extends Alias<Sources>, infer Field]
    ? Field extends keyof Sources[Key]["rowSchema"]["fields"] ? Sources[Key]["rowSchema"]["fields"][Field] : never
    : never

type SelectedValue<Sources extends Tables, Joins, Ref extends ReferenceFor<Sources>> =
  Ref extends readonly [infer Key, string]
    ? SelectedField<Sources, Ref>["Type"] | (Key extends LeftAlias<Joins> ? null : never)
    : never

type ViewSchema<Sources extends Tables, Joins, Selection extends SelectionFor<Sources>> = Schema.Codec<
  { readonly [Key in keyof Selection]: SelectedValue<Sources, Joins, Selection[Key]> },
  Readonly<Record<keyof Selection, unknown>>,
  SelectedField<Sources, Selection[keyof Selection]>["DecodingServices"],
  SelectedField<Sources, Selection[keyof Selection]>["EncodingServices"]
> & Readonly<{ fields: Readonly<Record<keyof Selection, Schema.Constraint>> }>

export interface SqliteView {
  readonly description: Description
  readonly dependencies: ReadonlyArray<Table>
}


class SqliteViewDefinitionError extends Schema.TaggedError<SqliteViewDefinitionError>()("SqliteViewDefinitionError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Invalid SQLite view definition: ${this.reason}`
  }
}

class SqliteViewListInputError extends Schema.TaggedError<SqliteViewListInputError>()(
  "SqliteViewListInputError",
  { reason: Schema.String },
) {}

const definitionError = (reason: string) => SqliteViewDefinitionError.make({ reason })
const decodeFailure = flow(Struct.get<Schema.SchemaError, "message">("message"), definitionError)
const decodeDefinition = Schema.decodeUnknownEffect(DefinitionSchema)
const decodeTable = Schema.decodeUnknownEffect(TableEvidenceSchema)
const equals = Equivalence.strictEqual<string>()
const qualified = ([alias, field]: Reference) => `${quoteIdentifier(alias)}.${quoteIdentifier(field)}`
const freezeReference = ([alias, field]: Reference) => Object.freeze([alias, field] as const)
const isLeftJoin = (join: Join) => equals(join.kind, "left")
const renderCondition = (condition: Condition) => `${qualified(condition.left)} = ${qualified(condition.right)}`

// Reject ambiguous left joins because SQL null cannot also stand for a decoded application value.
const nullTransform = (layer: ScalarF<boolean>) => pipe(
  Match.value(layer),
  Match.tag("Leaf", Function.constant(false)),
  Match.tag("Unsupported", Function.constant(true)),
  Match.tag("Suspend", "Collection", Struct.get<{ readonly value: boolean }, "value">("value")),
  Match.tag("Union", ({ members }) => Array.some(members, Function.identity)),
  Match.tag("Encoding", ({ ast, value }) => {
    const encoded = SchemaAST.toEncoded(ast)
    const EncodedSchema = Schema.make(encoded)
    const acceptsNull = Schema.is(EncodedSchema)(null)
    return acceptsNull || value
  }),
  Match.exhaustive,
)

const transformsNull = ScalarSchema.fold("storage", nullTransform)

const freezeCondition = ({ left, right }: Condition) => {
  const frozenLeft = freezeReference(left)
  const frozenRight = freezeReference(right)
  return Object.freeze({ left: frozenLeft, right: frozenRight })
}

const freezeJoin = (join: Join) => {
  const conditions = Array.map(join.on, freezeCondition)
  const on = Object.freeze(conditions)
  return Object.freeze({ ...join, on })
}

const uniqueNames = (kind: string) => (names: ReadonlyArray<string>) =>
  Effect.reduce(names, HashSet.empty<string>, Effect.fn("SqliteView.uniqueName")(function* (seen, name) {
    const normalized = name.toLowerCase()
    if (HashSet.has(seen, normalized)) return yield* definitionError(`duplicate ${kind} ${name}`)
    return HashSet.add(seen, normalized)
  }))

const compile = Effect.fn("SqliteView.compile")(function* (definition: Definition) {
  const input = yield* pipe(decodeDefinition(definition), Effect.mapError(decodeFailure))
  const tableNames = Record.keys(input.tables)
  if (Array.isReadonlyArrayEmpty(tableNames)) return yield* definitionError("tables must be nonempty")
  yield* uniqueNames("table alias")(tableNames)
  const outputNames = Record.keys(input.select)
  if (Array.isReadonlyArrayEmpty(outputNames)) return yield* definitionError("select must contain at least one output")
  yield* uniqueNames("selected output")(outputNames)

  const tableEntries = Record.toEntries(input.tables)

  const compiledTables = yield* Effect.forEach(tableEntries, Effect.fn("SqliteView.table")(function* ([alias, value]) {
    const table = yield* pipe(decodeTable(value), Effect.mapError(decodeFailure))
    return [alias, table] as const
  }))

  const sources = Record.fromEntries(compiledTables)

  const tableFor = (alias: string) => pipe(
    Record.get(sources, alias),
    Effect.fromOption(() => definitionError(`unknown table alias ${alias}`)),
  )

  const fieldFor = Effect.fn("SqliteView.field")(function* (reference: Reference) {
    const [alias, field] = reference
    const table = yield* tableFor(alias)

    const metadata = yield* pipe(
      Array.findFirst(table.fields, flow(Struct.get("name"), (name) => equals(name, field))),
      Effect.fromOption(() => definitionError(`unknown field ${alias}.${field}`)),
    )

    const column = yield* pipe(
      Record.get(table.columns, field),
      Effect.fromOption(() => definitionError(`missing compiled column ${alias}.${field}`)),
    )

    return { metadata, storage: column.storageSchema, orderable: column.orderable }
  })

  yield* tableFor(input.from)
  const initialAliases = () => HashSet.make(input.from)

  const introduced = yield* Effect.reduce(input.joins, initialAliases, Effect.fn("SqliteView.join")(function* (seen, join) {
    yield* tableFor(join.table)
    if (HashSet.has(seen, join.table)) return yield* definitionError(`duplicate join alias ${join.table}`)
    if (Array.isReadonlyArrayEmpty(join.on)) return yield* definitionError(`join ${join.table} must contain at least one equality`)

    yield* Effect.forEach(join.on, Effect.fn("SqliteView.joinCondition")(function* (condition) {
      const [leftAlias] = condition.left
      const [rightAlias] = condition.right
      const leftJoined = equals(leftAlias, join.table)
      const rightJoined = equals(rightAlias, join.table)
      const sameSide = Equivalence.strictEqual<boolean>()(leftJoined, rightJoined)
      if (sameSide) return yield* definitionError(`join ${join.table} equality must connect the new alias to an introduced alias`)
      const prior = leftJoined ? rightAlias : leftAlias
      if (!HashSet.has(seen, prior)) return yield* definitionError(`join ${join.table} references an alias not yet introduced`)
      const left = yield* fieldFor(condition.left)
      const right = yield* fieldFor(condition.right)
      const sameScalar = equals(left.metadata.scalar, right.metadata.scalar)
      const leftNumeric = !equals(left.metadata.scalar, "string")
      const rightNumeric = !equals(right.metadata.scalar, "string")
      const numeric = leftNumeric && rightNumeric
      const compatible = sameScalar || numeric
      if (!compatible) return yield* definitionError(`join ${join.table} has incompatible physical scalars`)
    }))

    return HashSet.add(seen, join.table)
  }))

  const introducedCount = HashSet.size(introduced)
  const complete = Equivalence.strictEqual<number>()(introducedCount, tableNames.length)
  if (!complete) return yield* definitionError("every table alias must be the from alias or appear in a join")
  const leftAliases = pipe(input.joins, Array.filter(isLeftJoin), Array.map(Struct.get("table")), HashSet.fromIterable)
  const tableDescriptions = Record.map(sources, Struct.get("name"))
  const tables = Object.freeze(tableDescriptions)
  const frozenJoins = Array.map(input.joins, freezeJoin)
  const joins = Object.freeze(frozenJoins)
  const frozenSelection = Record.map(input.select, freezeReference)
  const selection = Object.freeze(frozenSelection)
  const description: Description = Object.freeze({ tables, from: input.from, joins, select: selection })
  const entries = Record.toEntries(description.select)

  const fields = yield* Effect.forEach(entries, Effect.fn("SqliteView.projection")(function* ([output, reference]) {
    const [alias, name] = reference
    const field = yield* fieldFor(reference)
    const nullable = HashSet.has(leftAliases, alias)
    const nullableStorage = nullable && field.metadata.nullable

    const original = pipe(
      Record.get(definition.tables, alias),
      Option.flatMap(flow(Struct.get("rowSchema"), Struct.get("fields"), Record.get(name))),
      Option.map(Struct.get("ast")),
    )

    const ambiguous = nullableStorage && Option.exists(original, transformsNull)

    if (ambiguous) {
      return yield* definitionError(`left-joined field ${alias}.${name} transforms stored null; use an authored query with an explicit row-presence discriminator`)
    }

    const storageSchema = nullable ? Schema.NullOr(field.storage) : field.storage
    const nonNullable = Equivalence.strictEqual<boolean>()(nullable, false)
    const orderable = field.orderable && nonNullable
    const projectedField = Object.freeze({ reference, storageSchema, orderable })

    return [output, projectedField] as const
  }))

  const projected = Record.fromEntries(fields)
  const schemas = Record.map(projected, Struct.get("storageSchema"))
  const ResultSchema = Schema.Struct(schemas)
  const dependencyTables = pipe(definition.tables, Record.values, Array.dedupe)
  const dependencies = Object.freeze(dependencyTables)
  const columns = Array.map(entries, ([output, reference]) => `${qualified(reference)} AS ${quoteIdentifier(output)}`)

  const renderedJoins = yield* Effect.forEach(description.joins, Effect.fn("SqliteView.renderJoin")(function* (join) {
    const table = yield* tableFor(join.table)
    const kind = equals(join.kind, "left") ? "LEFT JOIN" : "INNER JOIN"
    const conditions = Array.map(join.on, renderCondition)
    const on = Array.join(conditions, " AND ")
    return `${kind} ${quoteIdentifier(table.name)} AS ${quoteIdentifier(join.table)} ON ${on}`
  }))

  const source = yield* tableFor(description.from)
  const columnSql = Array.join(columns, ", ")
  const joinSql = Array.join(renderedJoins, " ")
  const querySql = `SELECT ${columnSql} FROM ${quoteIdentifier(source.name)} AS ${quoteIdentifier(description.from)} ${joinSql}`
  const select = (sql: SqlClient.SqlClient) => sql.literal(querySql)

  const qualifiedColumns = Record.map(sources, (table, alias) => pipe(
    table.columns,
    Record.map((_, field) => qualified([alias, field])),
  ))

  const column = (sql: SqlClient.SqlClient, [alias, field]: Reference) => pipe(
    Record.get(qualifiedColumns, alias),
    Option.flatMap(Record.get(field)),
    Option.getOrThrowWith(() => definitionError(`unknown field ${alias}.${field}`)),
    sql.literal,
  )

  return { schema: ResultSchema, projected, description, dependencies, select, column }
})

const make = <
  const Sources extends Tables,
  const Joins extends ReadonlyArray<JoinFor<Sources>>,
  const Selection extends SelectionFor<Sources>,
>(definition: Readonly<{
  tables: Sources
  from: Alias<Sources>
  joins: Joins
  select: Selection
}>) => {
  const { tables, from, joins, select } = definition
  const compilation = compile({ tables, from, joins, select })
  const result = Effect.runSync(compilation)
  const column = (sql: SqlClient.SqlClient, reference: ReferenceFor<Sources>) => result.column(sql, reference)

  const outputField = (sql: SqlClient.SqlClient, field: string) => pipe(
    Record.get(result.projected, field),
    Option.map(Struct.get("reference")),
    Option.getOrThrow,
    (reference) => result.column(sql, reference),
  )

  const output = (sql: SqlClient.SqlClient, field: Extract<keyof Selection, string>) =>
    outputField(sql, field)

  return Object.freeze({
    ...result,
    schema: result.schema as ViewSchema<Sources, Joins, Selection>,
    column,
    output,
    outputField,
  })
}

type ListableView = SqliteView & Readonly<{
  schema: Schema.Constraint & Readonly<{ fields: Readonly<Record<string, Schema.Constraint>> }>
  projected: Readonly<Record<string, Readonly<{ orderable: boolean }>>>
  select: (sql: SqlClient.SqlClient) => ReturnType<SqlClient.SqlClient["literal"]>
  outputField: (sql: SqlClient.SqlClient, field: string) => ReturnType<SqlClient.SqlClient["literal"]>
}>

type ViewField<View extends ListableView> = Extract<keyof View["schema"]["Type"], string>
type ViewRow<View extends ListableView> = View["schema"]["Type"]

type ViewFilter<View extends ListableView, Fields extends ReadonlyArray<ViewField<View>>> =
  Readonly<Partial<Pick<ViewRow<View>, Fields[number]>>>

type ViewRange<View extends ListableView, Fields extends ReadonlyArray<ViewField<View>>> = Readonly<Partial<{
  [Field in Fields[number]]: Readonly<Partial<{ from: ViewRow<View>[Field]; to: ViewRow<View>[Field] }>>
}>>

type ViewListRequest<
  View extends ListableView,
  Filter extends ReadonlyArray<ViewField<View>>,
  Range extends ReadonlyArray<ViewField<View>>,
> = Readonly<Partial<{
  filter: ViewFilter<View, Filter>
  range: ViewRange<View, Range>
  limit: number
  cursor: string
}>>

const StoredFilterSchema = Schema.Record(Schema.String, Schema.Unknown)

const StoredRangeBoundsSchema = Schema.Struct({
  from: Schema.optionalKey(Schema.Unknown),
  to: Schema.optionalKey(Schema.Unknown),
})

const StoredRangeSchema = Schema.Record(Schema.String, StoredRangeBoundsSchema)

const invalidList = (reason: string) => SqliteViewListInputError.make({ reason })
const unknownEquals = Equivalence.strictEqual<unknown>()

const freezeOrder = <Field extends string>(
  [field, direction]: readonly [Field, "asc" | "desc"],
) => Object.freeze([field, direction] as const)

const orderField = <Field extends string>(entry: readonly [Field, "asc" | "desc"]) =>
  Tuple.get(entry, 0)

const list = <
  const View extends ListableView,
  const Filter extends ReadonlyArray<ViewField<View>> = readonly [],
  const Range extends ReadonlyArray<ViewField<View>> = readonly [],
  const Order extends ReadonlyArray<readonly [ViewField<View>, "asc" | "desc"]> = ReadonlyArray<
    readonly [ViewField<View>, "asc" | "desc"]
  >,
>(definition: Readonly<{
  view: View
  order: Order
}> & Readonly<Partial<{
  filter: Filter
  range: Range
  limit: number
}>>) => {
  const sourceFilterFields: ReadonlyArray<ViewField<View>> = definition.filter ?? []
  const copiedFilterFields = Array.fromIterable(sourceFilterFields)
  const filterFields = Object.freeze(copiedFilterFields)
  const sourceRangeFields: ReadonlyArray<ViewField<View>> = definition.range ?? []
  const copiedRangeFields = Array.fromIterable(sourceRangeFields)
  const rangeFields = Object.freeze(copiedRangeFields)
  const copiedOrderSource = Array.fromIterable(definition.order)
  const copiedOrder = Array.map(copiedOrderSource, freezeOrder)
  const order = Object.freeze(copiedOrder)
  const maximum = definition.limit ?? 50
  const validMaximum = Schema.is(PageLimitSchema)(maximum)

  if (!validMaximum) pipe(definitionError("list limit must be between 1 and 100"), Effect.runSync)
  if (Array.isReadonlyArrayEmpty(order)) pipe(definitionError("list order must contain at least one field"), Effect.runSync)

  const orderFields = Array.map(order, orderField)
  const filterAndRangeFields = Array.appendAll(filterFields, rangeFields)
  const allFields = Array.appendAll(filterAndRangeFields, orderFields)
  const isMissing = (field: ViewField<View>) => !Record.has(definition.view.projected, field)
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
    const projected = pipe(Record.get(definition.view.projected, field), Option.getOrThrow)
    return !projected.orderable
  }

  const notOrderable = Array.findFirst(rangeAndOrderFields, isNotOrderable)

  if (Option.isSome(notOrderable)) {
    pipe(definitionError(`list field ${notOrderable.value} must preserve non-null storage ordering`), Effect.runSync)
  }

  const schemaFor = (field: ViewField<View>) => pipe(
    Record.get(definition.view.schema.fields, field),
    Option.getOrThrow,
  )

  const canonicalEntry = (field: ViewField<View>) =>
    [field, Schema.optionalKey(Schema.toType(schemaFor(field)))] as const

  const storageEntry = (field: ViewField<View>) =>
    [field, Schema.optionalKey(schemaFor(field))] as const

  const canonicalFilterEntries = Array.map(filterFields, canonicalEntry)
  const storageFilterEntries = Array.map(filterFields, storageEntry)
  const canonicalFilterFields = Record.fromEntries(canonicalFilterEntries)
  const storageFilterFields = Record.fromEntries(storageFilterEntries)

  const CanonicalFilterSchema = Schema.Struct(canonicalFilterFields)
    .annotate({ parseOptions: { onExcessProperty: "error" } })

  const StorageFilterSchema = Schema.Struct(storageFilterFields)

  const canonicalRangeEntry = (field: ViewField<View>) => [field, Schema.optionalKey(Schema.Struct({
    from: Schema.optionalKey(Schema.toType(schemaFor(field))),
    to: Schema.optionalKey(Schema.toType(schemaFor(field))),
  }))] as const

  const storageRangeEntry = (field: ViewField<View>) => [field, Schema.optionalKey(Schema.Struct({
    from: Schema.optionalKey(schemaFor(field)),
    to: Schema.optionalKey(schemaFor(field)),
  }))] as const

  const canonicalRangeEntries = Array.map(rangeFields, canonicalRangeEntry)
  const storageRangeEntries = Array.map(rangeFields, storageRangeEntry)
  const canonicalRangeFields = Record.fromEntries(canonicalRangeEntries)
  const storageRangeFields = Record.fromEntries(storageRangeEntries)

  const CanonicalRangeSchema = Schema.Struct(canonicalRangeFields)
    .annotate({ parseOptions: { onExcessProperty: "error" } })

  const StorageQueryRangeSchema = Schema.Struct(storageRangeFields)
  const MaximumLimitSchema = PageLimitSchema.check(Schema.isLessThanOrEqualTo(maximum))

  const InputShapeSchema = Schema.Struct({
    filter: Schema.optionalKey(CanonicalFilterSchema),
    range: Schema.optionalKey(CanonicalRangeSchema),
    limit: Schema.optionalKey(MaximumLimitSchema),
    cursor: Schema.optionalKey(Schema.String),
  }).annotate({ parseOptions: { onExcessProperty: "error" } })

  const payloadSchema = Schema.make<Schema.Codec<ViewListRequest<View, Filter, Range>, unknown>>(InputShapeSchema.ast)
  const CanonicalRowSchema = Schema.toType(definition.view.schema)
  const SuccessShapeSchema = Page.schema(CanonicalRowSchema)

  const successSchema = Schema.make<Schema.Codec<
    Readonly<{ items: ReadonlyArray<ViewRow<View>>; nextCursor: string | null }>,
    typeof SuccessShapeSchema.Encoded,
    typeof SuccessShapeSchema.DecodingServices,
    typeof SuccessShapeSchema.EncodingServices
  >>(SuccessShapeSchema.ast)

  const cursorEntry = (entry: readonly [ViewField<View>, "asc" | "desc"]) => {
    const field = Tuple.get(entry, 0)
    return [field, Schema.toEncoded(schemaFor(field))] as const
  }

  const cursorEntries = Array.map(order, cursorEntry)
  const cursorAfterFields = Record.fromEntries(cursorEntries)
  const CursorAfterShapeSchema = Schema.Struct(cursorAfterFields)

  const CursorAfterSchema = Schema.make<Schema.Codec<
    Readonly<Record<string, unknown>>,
    unknown
  >>(CursorAfterShapeSchema.ast)

  const cursorScope = JSON.stringify({
    view: definition.view.description,
    filter: filterFields,
    range: rangeFields,
    order,
  })

  const cursorCodec = Page.cursor(cursorScope, CursorAfterSchema)
  const decodeRows = Schema.decodeUnknownEffect(Schema.Array(definition.view.schema))
  const encodeFilter = Schema.encodeUnknownEffect(StorageFilterSchema)
  const encodeRange = Schema.encodeUnknownEffect(StorageQueryRangeSchema)
  const decodeFilter = Schema.decodeUnknownEffect(StoredFilterSchema)
  const decodeRange = Schema.decodeUnknownEffect(StoredRangeSchema)
  const isLimit = Schema.is(MaximumLimitSchema)
  const noCursor = Option.none<typeof CursorAfterSchema.Type>()
  const noCursorEffect = Effect.succeed(noCursor)

  const execute = Effect.fn("SqliteView.list")(function* (
    input: ViewListRequest<View, Filter, Range>,
  ) {
    const sql = yield* SqlClient.SqlClient
    const limit = input.limit ?? maximum

    if (!isLimit(limit)) return yield* invalidList(`list limit must be between 1 and ${maximum}`)

    const rawFilter = yield* encodeFilter(input.filter ?? {})
    const rawRange = yield* encodeRange(input.range ?? {})
    const filter = yield* decodeFilter(rawFilter)
    const range = yield* decodeRange(rawRange)
    const expectedFilter = JSON.stringify(filter)
    const expectedRange = JSON.stringify(range)

    const decodeCursor = Effect.fn("SqliteView.decodeCursor")(function* (source: string) {
      const decoded = yield* pipe(
        cursorCodec.parse(source),
        Effect.mapError(() => invalidList("invalid list cursor")),
      )

      const actualFilter = JSON.stringify(decoded.filter)
      const actualRange = JSON.stringify(decoded.range)
      const filterMatches = equals(actualFilter, expectedFilter)
      const rangeMatches = equals(actualRange, expectedRange)
      const filterMismatch = !filterMatches
      const rangeMismatch = !rangeMatches
      const cursorMismatch = filterMismatch || rangeMismatch

      if (cursorMismatch) {
        return yield* invalidList("list cursor does not match the requested filter or range")
      }

      return Option.some(decoded.after)
    })

    const requestedCursor = Option.fromNullishOr(input.cursor)

    const cursor = yield* Option.match(requestedCursor, {
      onNone: Function.constant(noCursorEffect),
      onSome: decodeCursor,
    })

    const column = (field: string) => definition.view.outputField(sql, field)

    const renderFilterCondition = ([field, value]: readonly [string, unknown]) =>
      unknownEquals(value, null)
        ? sql`${column(field)} IS NULL`
        : sql`${column(field)} = ${value}`

    const filterEntries = Record.toEntries(filter)
    const filterPredicates = Array.map(filterEntries, renderFilterCondition)

    const renderRangeConditions = ([field, bounds]: readonly [
      string,
      Readonly<Partial<{ from: unknown; to: unknown }>>,
    ]) => {
      const lower = "from" in bounds
        ? Option.some(sql`${column(field)} >= ${bounds.from}`)
        : Option.none()

      const upper = "to" in bounds
        ? Option.some(sql`${column(field)} <= ${bounds.to}`)
        : Option.none()

      return Array.getSomes([lower, upper])
    }

    const rangeEntries = Record.toEntries(range)
    const rangePredicates = Array.flatMap(rangeEntries, renderRangeConditions)

    const keysetFor = (after: typeof CursorAfterSchema.Type) => {
      const renderKeysetCondition = ([field, direction]: readonly [ViewField<View>, "asc" | "desc"], index: number) => {
        const previous = Array.take(order, index)

        const equality = ([prior]: readonly [ViewField<View>, "asc" | "desc"]) =>
          sql`${column(prior)} = ${after[prior]}`

        const equalities = Array.map(previous, equality)

        const comparison = equals(direction, "asc")
          ? sql`${column(field)} > ${after[field]}`
          : sql`${column(field)} < ${after[field]}`

        const orderedComparison = Array.append(equalities, comparison)
        return sql.and(orderedComparison)
      }

      return Array.map(order, renderKeysetCondition)
    }

    const keysetPredicates = Option.match(cursor, {
      onNone: Array.empty,
      onSome: keysetFor,
    })

    const predicates = Array.appendAll(filterPredicates, rangePredicates)
    const cursorPredicate = sql.or(keysetPredicates)

    const withCursor = Array.isReadonlyArrayEmpty(keysetPredicates)
      ? predicates
      : Array.append(predicates, cursorPredicate)

    const noPredicate = Array.isReadonlyArrayEmpty(withCursor)
    const truePredicate = sql.literal("1 = 1")
    const where = noPredicate ? truePredicate : sql.and(withCursor)

    const orderFragment = ([field, direction]: readonly [ViewField<View>, "asc" | "desc"]) => {
      const directionName = equals(direction, "asc") ? "ASC" : "DESC"
      const directionSql = sql.literal(directionName)
      return sql`${column(field)} ${directionSql}`
    }

    const orderFragments = Array.map(order, orderFragment)

    const rows = yield* sql<Readonly<Record<string, unknown>>>`
      ${definition.view.select(sql)}
      WHERE ${where}
      ORDER BY ${sql.csv(orderFragments)}
      LIMIT ${limit + 1}
    `

    const stored = Array.take(rows, limit)
    const items = yield* decodeRows(stored)
    const noLast = Option.none<Readonly<Record<string, unknown>>>()
    const last = rows.length > limit ? Array.last(stored) : noLast

    const renderCursor = Effect.fn("SqliteView.renderCursor")(function* (
      row: Readonly<Record<string, unknown>>,
    ) {
      const afterEntry = (entry: readonly [ViewField<View>, "asc" | "desc"]) => {
        const field = Tuple.get(entry, 0)
        const value = pipe(Record.get(row, field), Option.getOrThrow)
        return [field, value] as const
      }

      const afterEntries = Array.map(order, afterEntry)
      const after = Record.fromEntries(afterEntries)

      return yield* pipe(
        cursorCodec.render({ filter, range, after }),
        Effect.mapError(() => invalidList("could not encode list cursor")),
      )
    })

    const noNextCursor = Effect.succeed<string | null>(null)

    const nextCursor = yield* Option.match(last, {
      onNone: Function.constant(noNextCursor),
      onSome: renderCursor,
    })

    return { items, nextCursor }
  })

  type HandlerRequirements =
    | SqlClient.SqlClient
    | View["schema"]["DecodingServices"]
    | View["schema"]["EncodingServices"]

  type HandlerError = Effect.Error<ReturnType<typeof execute>>
  const frozenDependencies = Object.freeze([definition.view])

  return Object.freeze({
    payload: payloadSchema,
    success: successSchema,
    errors: SqliteViewListInputError,
    dependencies: frozenDependencies,
    handler: execute as (
      input: ViewListRequest<View, Filter, Range>
    ) => Effect.Effect<typeof successSchema.Type, HandlerError, HandlerRequirements>,
  })
}


export const SqliteView = { make, list, listOperation: Operation.listOperation }
