import { Array, Effect, Equivalence, Function, HashSet, Match, Option, Record, Schema, Struct, Tuple, flow, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { PageLimitSchema } from "./domain.ts"
import { Page } from "./page.ts"
import { Command } from "./command.ts"
import { Resource, type AnyResourceSpec, type ResourceSpec, type ResourceTable } from "./resource.ts"
import { quoteIdentifier } from "./sqlite-ddl.ts"
import { RepositoryOrder, RepositorySelect } from "./repository-store.ts"
import { SqliteList } from "./sqlite-list.ts"
import { TableField, type Table } from "./table.ts"
import { SchemaField } from "./schema-field.ts"

const NameSchema = Schema.NonEmptyString.check(Schema.isPattern(/\S/))
const ReferenceSchema = Schema.Tuple([NameSchema, NameSchema])
const ConditionSchema = Schema.Struct({ left: ReferenceSchema, right: ReferenceSchema })
const JoinSchema = Schema.Struct({ kind: Schema.Literals(["inner", "left"]), table: NameSchema, on: Schema.Array(ConditionSchema) })
const SelectionSchema = Schema.Record(NameSchema, ReferenceSchema)

export const ReadModelDescriptionSchema = Schema.Struct({
  tables: Schema.Record(NameSchema, NameSchema),
  from: NameSchema,
  joins: Schema.Array(JoinSchema),
  select: SelectionSchema,
}).annotate({ parseOptions: { onExcessProperty: "error" } })

interface Description extends Schema.Schema.Type<typeof ReadModelDescriptionSchema> {}
interface Join extends Schema.Schema.Type<typeof JoinSchema> {}
interface Condition extends Schema.Schema.Type<typeof ConditionSchema> {}
type Reference = Schema.Schema.Type<typeof ReferenceSchema>
type TableSource = Table | AnyResourceSpec
type Tables = Readonly<Record<string, TableSource>>
type CompiledTables = Readonly<Record<string, Table>>
type SourceTable<Source extends TableSource> =
  Source extends AnyResourceSpec ? ResourceTable<Source> : Source
type CompiledSources<Sources extends Tables> = {
  readonly [Key in keyof Sources]: SourceTable<Sources[Key]>
}
type Alias<Sources extends Tables> = Extract<keyof Sources, string>

const ColumnEvidenceSchema = Schema.Struct({
  storageSchema: Schema.declare<Schema.Constraint>(Schema.isSchema),
  orderable: Schema.Boolean,
  transformsStoredNull: Schema.Boolean,
})

const TableEvidenceSchema = Schema.Struct({
  name: NameSchema,
  fields: Schema.Array(TableField),
  columns: Schema.Record(Schema.String, ColumnEvidenceSchema),
})


const DefinitionSchema = Schema.Struct({
  ...ReadModelDescriptionSchema.fields,
  tables: Schema.Record(NameSchema, Schema.Unknown),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

type Definition = Omit<Description, "tables"> & { readonly tables: CompiledTables }

export type ReadModelF<A> =
  | Readonly<{ readonly _tag: "Scan"; readonly alias: string; readonly table: TableSource }>
  | Readonly<{
    readonly _tag: "Join"
    readonly source: A
    readonly kind: "inner" | "left"
    readonly alias: string
    readonly table: TableSource
    readonly on: ReadonlyArray<Condition>
  }>
  | Readonly<{
    readonly _tag: "Project"
    readonly source: A
    readonly select: Readonly<Record<string, Reference>>
  }>
  | Readonly<{
    readonly _tag: "Page"
    readonly source: A
    readonly filter: ReadonlyArray<string>
    readonly range: ReadonlyArray<string>
    readonly order: ReadonlyArray<readonly [string, "asc" | "desc"]>
    readonly limit: number
  }>

export type ReadModelSyntax =
  | Readonly<{ readonly _tag: "Scan"; readonly alias: string; readonly table: TableSource }>
  | Readonly<{
    readonly _tag: "Join"
    readonly source: ReadModelSyntax
    readonly kind: "inner" | "left"
    readonly alias: string
    readonly table: TableSource
    readonly on: ReadonlyArray<Condition>
  }>
  | Readonly<{
    readonly _tag: "Project"
    readonly source: ReadModelSyntax
    readonly select: Readonly<Record<string, Reference>>
  }>
  | Readonly<{
    readonly _tag: "Page"
    readonly source: ReadModelSyntax
    readonly filter: ReadonlyArray<string>
    readonly range: ReadonlyArray<string>
    readonly order: ReadonlyArray<readonly [string, "asc" | "desc"]>
    readonly limit: number
  }>

const ReadModelLayer = <A, E>(child: Schema.Codec<A, E>) => Schema.TaggedUnion({
  Scan: { alias: NameSchema, table: Schema.Unknown },
  Join: {
    source: child,
    kind: Schema.Literals(["inner", "left"]),
    alias: NameSchema,
    table: Schema.Unknown,
    on: Schema.Array(ConditionSchema),
  },
  Project: { source: child, select: SelectionSchema },
  Page: {
    source: child,
    filter: Schema.Array(NameSchema),
    range: Schema.Array(NameSchema),
    order: Schema.Array(Schema.Tuple([NameSchema, Schema.Literals(["asc", "desc"])])),
    limit: PageLimitSchema,
  },
})

export const ReadModelSyntaxSchema: Schema.Codec<ReadModelSyntax> = Schema.suspend(
  (): Schema.Codec<ReadModelSyntax> =>
    ReadModelLayer(ReadModelSyntaxSchema) as Schema.Codec<ReadModelSyntax>,
)

const mapReadModelF = <A, B>(
  layer: ReadModelF<A>,
  child: (value: A) => B,
): ReadModelF<B> => pipe(
  Match.value(layer),
  Match.tag("Scan", (node) => node),
  Match.tag("Join", "Project", "Page", (node) => ({
    ...node,
    source: child(node.source),
  })),
  Match.exhaustive,
)

export type ReadModelAlgebra<A> = (layer: ReadModelF<A>) => A

const foldReadModel = <A>(algebra: ReadModelAlgebra<A>) => {
  const interpret = (syntax: ReadModelSyntax): A =>
    algebra(mapReadModelF<ReadModelSyntax, A>(syntax, interpret))
  return interpret
}

export interface ReadModelSpec<
  Sources extends Tables = Tables,
  Joins extends ReadonlyArray<JoinFor<Sources>> = ReadonlyArray<JoinFor<Sources>>,
  Selection extends SelectionFor<Sources> = SelectionFor<Sources>,
> {
  readonly _tag: "ReadModelSpec"
  readonly syntax: ReadModelSyntax
  readonly definition: Readonly<{
    readonly tables: Sources
    readonly from: Alias<Sources>
    readonly joins: Joins
    readonly select: Selection
  }>
}

type ReferenceFor<Sources extends Tables> = {
  [Key in Alias<Sources>]: readonly [Key, Extract<keyof SourceTable<Sources[Key]>["rowSchema"]["fields"], string>]
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
    ? Field extends keyof SourceTable<Sources[Key]>["rowSchema"]["fields"]
      ? SourceTable<Sources[Key]>["rowSchema"]["fields"][Field]
      : never
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

export interface CompiledReadModel {
  readonly _tag: "CompiledReadModel"
  readonly description: Description
  readonly dependencies: ReadonlyArray<Table>
}


class ReadModelDefinitionError extends Schema.TaggedError<ReadModelDefinitionError>()("ReadModelDefinitionError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Invalid SQLite view definition: ${this.reason}`
  }
}

class ReadModelInputError extends Schema.TaggedError<ReadModelInputError>()(
  "ReadModelInputError",
  { reason: Schema.String },
) {}

const definitionError = (reason: string) => ReadModelDefinitionError.make({ reason })
const decodeFailure = flow(Struct.get<Schema.SchemaError, "message">("message"), definitionError)
const decodeDefinition = Schema.decodeUnknownEffect(DefinitionSchema)
const decodeTable = Schema.decodeUnknownEffect(TableEvidenceSchema)
const equals = Equivalence.strictEqual<string>()
const qualified = ([alias, field]: Reference) => `${quoteIdentifier(alias)}.${quoteIdentifier(field)}`
const freezeReference = ([alias, field]: Reference) => Object.freeze([alias, field] as const)
const isLeftJoin = (join: Join) => equals(join.kind, "left")
const renderCondition = (condition: Condition) => `${qualified(condition.left)} = ${qualified(condition.right)}`


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
  Effect.reduce(names, HashSet.empty<string>, Effect.fn("ReadModel.uniqueName")(function* (seen, name) {
    const normalized = name.toLowerCase()
    if (HashSet.has(seen, normalized)) return yield* definitionError(`duplicate ${kind} ${name}`)
    return HashSet.add(seen, normalized)
  }))

const compile = Effect.fn("ReadModel.compile")(function* (definition: Definition) {
  const input = yield* pipe(decodeDefinition(definition), Effect.mapError(decodeFailure))
  const tableNames = Record.keys(input.tables)
  if (Array.isReadonlyArrayEmpty(tableNames)) return yield* definitionError("tables must be nonempty")
  yield* uniqueNames("table alias")(tableNames)
  const outputNames = Record.keys(input.select)
  if (Array.isReadonlyArrayEmpty(outputNames)) return yield* definitionError("select must contain at least one output")
  yield* uniqueNames("selected output")(outputNames)

  const tableEntries = Record.toEntries(input.tables)

  const compiledTables = yield* Effect.forEach(tableEntries, Effect.fn("ReadModel.table")(function* ([alias, value]) {
    const table = yield* pipe(decodeTable(value), Effect.mapError(decodeFailure))
    return [alias, table] as const
  }))

  const sources = Record.fromEntries(compiledTables)

  const tableFor = (alias: string) => pipe(
    Record.get(sources, alias),
    Effect.fromOption(() => definitionError(`unknown table alias ${alias}`)),
  )

  const fieldFor = Effect.fn("ReadModel.field")(function* (reference: Reference) {
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

    return {
      metadata,
      storage: column.storageSchema,
      orderable: column.orderable,
      transformsStoredNull: column.transformsStoredNull,
    }
  })

  yield* tableFor(input.from)
  const initialAliases = () => HashSet.make(input.from)

  const introduced = yield* Effect.reduce(input.joins, initialAliases, Effect.fn("ReadModel.join")(function* (seen, join) {
    yield* tableFor(join.table)
    if (HashSet.has(seen, join.table)) return yield* definitionError(`duplicate join alias ${join.table}`)
    if (Array.isReadonlyArrayEmpty(join.on)) return yield* definitionError(`join ${join.table} must contain at least one equality`)

    yield* Effect.forEach(join.on, Effect.fn("ReadModel.joinCondition")(function* (condition) {
      const [leftAlias] = condition.left
      const [rightAlias] = condition.right
      const leftJoined = equals(leftAlias, join.table)
      const rightJoined = equals(rightAlias, join.table)
      const sameSide = Equivalence.strictEqual<boolean>()(leftJoined, rightJoined)
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

  const fields = yield* Effect.forEach(entries, Effect.fn("ReadModel.projection")(function* ([output, reference]) {
    const [alias, name] = reference
    const field = yield* fieldFor(reference)
    const nullable = HashSet.has(leftAliases, alias)
    const nullableStorage = nullable && field.metadata.nullable


    const ambiguous = nullableStorage && field.transformsStoredNull

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

  const renderedJoins = yield* Effect.forEach(description.joins, Effect.fn("ReadModel.renderJoin")(function* (join) {
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

const compileDefinition = <
  const Sources extends Tables,
  const Joins extends ReadonlyArray<JoinFor<Sources>>,
  const Selection extends SelectionFor<Sources>,
>(definition: Readonly<{
  tables: CompiledSources<Sources>
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
    _tag: "CompiledReadModel" as const,
    ...result,
    schema: result.schema as ViewSchema<Sources, Joins, Selection>,
    column,
    output,
    outputField,
  })
}

interface PageConfiguration {
  readonly filter: ReadonlyArray<string>
  readonly range: ReadonlyArray<string>
  readonly order: ReadonlyArray<readonly [string, "asc" | "desc"]>
  readonly limit: number
}

interface ReadModelPlan {
  readonly definition: Definition
  readonly page: Option.Option<PageConfiguration>
}

const emptySelection: Readonly<Record<string, Reference>> = Object.freeze({})
const noPage = Option.none<PageConfiguration>()

const compileSource = Match.type<TableSource>().pipe(
  Match.tagsExhaustive({
    Table: (table) => table,
    ResourceSpec: Resource.table,
  }),
)

const planAlgebra: ReadModelAlgebra<ReadModelPlan> = (layer) => pipe(
  Match.value(layer),
  Match.tagsExhaustive({
    Scan: ({ alias, table }) => ({
      definition: {
        tables: Record.singleton(alias, compileSource(table)),
        from: alias,
        joins: [],
        select: emptySelection,
      },
      page: noPage,
    }),
    Join: ({ source, kind, alias, table, on }) => ({
      definition: {
        ...source.definition,
        tables: Record.set(source.definition.tables, alias, compileSource(table)),
        joins: Array.append(source.definition.joins, { kind, table: alias, on }),
      },
      page: source.page,
    }),
    Project: ({ source, select }) => ({
      definition: { ...source.definition, select },
      page: source.page,
    }),
    Page: ({ source, filter, range, order, limit }) => ({
      definition: source.definition,
      page: Option.some({ filter, range, order, limit }),
    }),
  }),
)

const dependencyAlgebra: ReadModelAlgebra<ReadonlyArray<Table>> = (layer) => pipe(
  Match.value(layer),
  Match.tagsExhaustive({
    Scan: ({ table }) => [compileSource(table)],
    Join: ({ source, table }) =>
      Array.dedupeWith(
        Array.append(source, compileSource(table)),
        Equivalence.strictEqual<Table>(),
      ),
    Project: ({ source }) => source,
    Page: ({ source }) => source,
  }),
)

const compilePlan = foldReadModel(planAlgebra)
const readModelDependencies = foldReadModel(dependencyAlgebra)

const describeReadModel = (spec: ReadModelSpec): Description => {
  const plan = compilePlan(spec.syntax)
  return {
    ...plan.definition,
    tables: Record.map(plan.definition.tables, Struct.get("name")),
  }
}

const readModelSources = <const Sources extends Tables>(
  sources: Sources,
): Sources => Object.freeze({ ...sources })

const defineReadModel = <
  const Sources extends Tables,
  const Joins extends ReadonlyArray<JoinFor<NoInfer<Sources>>>,
  const Selection extends SelectionFor<NoInfer<Sources>>,
>(definition: Readonly<{
  tables: Sources
  from: Alias<Sources>
  joins: Joins
  select: Selection
}>): ReadModelSpec<Sources, Joins, Selection> => {
  const source = pipe(
    Record.get(definition.tables, definition.from),
    Option.getOrThrow,
  )

  const scan: ReadModelSyntax = {
    _tag: "Scan",
    alias: definition.from,
    table: source,
  }

  const joined = Array.reduce<JoinFor<Sources>, ReadModelSyntax>(
    definition.joins,
    scan,
    (syntax, join) => ({
      _tag: "Join",
      source: syntax,
      kind: join.kind,
      alias: join.table,
      table: pipe(Record.get(definition.tables, join.table), Option.getOrThrow),
      on: join.on as ReadonlyArray<Condition>,
    }),
  )

  const projected: ReadModelSyntax = {
    _tag: "Project",
    source: joined,
    select: definition.select as Readonly<Record<string, Reference>>,
  }

  const syntax = Schema.decodeUnknownSync(ReadModelSyntaxSchema)(projected)
  return Object.freeze({
    _tag: "ReadModelSpec" as const,
    syntax,
    definition,
  })
}

type CompiledReadModelFor<Spec extends ReadModelSpec> =
  Spec extends ReadModelSpec<infer Sources, infer Joins, infer Selection>
    ? ReturnType<typeof compileDefinition<Sources, Joins, Selection>>
    : never
type ReadModelField<Model extends ReadModelSpec> = Extract<
  keyof CompiledReadModelFor<Model>["schema"]["fields"],
  string
>

const compileReadModel = <const Spec extends ReadModelSpec>(
  spec: Spec,
): CompiledReadModelFor<Spec> => {
  const plan = compilePlan(spec.syntax)
  const declaredAliases = Record.keys(spec.definition.tables)
  Effect.runSync(uniqueNames("table alias")(declaredAliases))
  const compiledAliases = Record.keys(plan.definition.tables)
  if (declaredAliases.length !== compiledAliases.length) {
    pipe(
      definitionError("every table alias must be the from alias or appear in a join"),
      Effect.runSync,
    )
  }
  const compiled = compileDefinition(plan.definition as never)
  const dependencies = readModelDependencies(spec.syntax)
  return Object.freeze({ ...compiled, dependencies }) as CompiledReadModelFor<Spec>
}

interface ReadModelPageSpec<
  Model extends ReadModelSpec = ReadModelSpec,
  Filter extends ReadonlyArray<string> = ReadonlyArray<string>,
  Range extends ReadonlyArray<string> = ReadonlyArray<string>,
  Order extends ReadonlyArray<readonly [string, "asc" | "desc"]> =
    ReadonlyArray<readonly [string, "asc" | "desc"]>,
> {
  readonly _tag: "ReadModelPageSpec"
  readonly model: Model
  readonly syntax: ReadModelSyntax
  readonly filter: Filter
  readonly range: Range
  readonly order: Order
  readonly limit: number
}

const pageReadModel = <
  const Model extends ReadModelSpec,
  const Filter extends ReadonlyArray<ReadModelField<Model>> = readonly [],
  const Range extends ReadonlyArray<ReadModelField<Model>> = readonly [],
  const Order extends ReadonlyArray<
    readonly [ReadModelField<Model>, "asc" | "desc"]
  > = ReadonlyArray<readonly [ReadModelField<Model>, "asc" | "desc"]>,
>(definition: Readonly<{
  model: Model
  order: Order
}> & Readonly<Partial<{
  filter: Filter
  range: Range
  limit: number
}>>): ReadModelPageSpec<Model, Filter, Range, Order> => {
  const filter = definition.filter ?? [] as unknown as Filter
  const range = definition.range ?? [] as unknown as Range
  const limit = definition.limit ?? 50
  const syntax = Schema.decodeUnknownSync(ReadModelSyntaxSchema)({
    _tag: "Page",
    source: definition.model.syntax,
    filter,
    range,
    order: definition.order,
    limit,
  })

  return Object.freeze({
    _tag: "ReadModelPageSpec" as const,
    model: definition.model,
    syntax,
    filter,
    range,
    order: definition.order,
    limit,
  })
}

type ListableView = CompiledReadModel & Readonly<{
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


const invalidList = (reason: string) => ReadModelInputError.make({ reason })

const freezeOrder = <Field extends string>(
  [field, direction]: readonly [Field, "asc" | "desc"],
) => Object.freeze([field, direction] as const)

const orderField = <Field extends string>(entry: readonly [Field, "asc" | "desc"]) =>
  Tuple.get(entry, 0)

const compilePageDefinition = <
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

  const schemaFor = (field: string) => pipe(
    Record.get(definition.view.schema.fields, field),
    Option.getOrThrow,
  )

  const canonicalField = flow(schemaFor, Schema.toType)

  const repositoryOrderEntry = ([field, direction]: readonly [ViewField<View>, "asc" | "desc"]) =>
    new RepositoryOrder({ field, direction })

  const repositoryOrderEntries = Array.map(order, repositoryOrderEntry)
  const repositoryOrder = Object.freeze(repositoryOrderEntries)

  const cursorScope = JSON.stringify({
    view: definition.view.description,
    filter: filterFields,
    range: rangeFields,
    order,
  })

  const MaximumLimitSchema = PageLimitSchema.check(Schema.isLessThanOrEqualTo(maximum))
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
    maximum,
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
  const CanonicalRowSchema = Schema.toType(definition.view.schema)
  const SuccessShapeSchema = Page.schema(CanonicalRowSchema)

  const successSchema = Schema.make<Schema.Codec<
    Readonly<{ items: ReadonlyArray<ViewRow<View>>; nextCursor: string | null }>,
    typeof SuccessShapeSchema.Encoded,
    typeof SuccessShapeSchema.DecodingServices,
    typeof SuccessShapeSchema.EncodingServices
  >>(SuccessShapeSchema.ast)

  const decodeRows = Schema.decodeUnknownEffect(Schema.Array(definition.view.schema))

  const execute = Effect.fn("ReadModel.page")(function* (
    input: ViewListRequest<View, Filter, Range>,
  ) {
    const sql = yield* SqlClient.SqlClient
    const requestedFilter = (input.filter ?? Record.empty()) as RepositorySelect["filter"]
    const requestedRange = (input.range ?? Record.empty()) as RepositorySelect["range"]
    const requestedLimit = Option.fromNullishOr(input.limit)
    const requestedCursor = Option.fromNullishOr(input.cursor)

    const prepared = yield* listPlan.prepare<View["schema"]["EncodingServices"]>(
      requestedFilter,
      requestedRange,
      requestedLimit,
      requestedCursor,
    )

    const column = (field: string) => definition.view.outputField(sql, field)

    const rendered = SqliteList.render(
      sql,
      column,
      prepared.query,
    )

    const rows = yield* sql<Readonly<Record<string, unknown>>>`
      ${definition.view.select(sql)}
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

  type HandlerError = Effect.Error<ReturnType<typeof execute>>
  const frozenDependencies = Object.freeze([definition.view])

  return Object.freeze({
    payload: payloadSchema,
    success: successSchema,
    errors: ReadModelInputError,
    dependencies: frozenDependencies,
    handler: execute as (
      input: ViewListRequest<View, Filter, Range>
    ) => Effect.Effect<typeof successSchema.Type, HandlerError, HandlerRequirements>,
  })
}

type PageView<Spec extends ReadModelPageSpec> =
  CompiledReadModelFor<Spec["model"]>

type PageRow<Spec extends ReadModelPageSpec> =
  PageView<Spec>["schema"]["Type"]

type PageFilterFields<Spec extends ReadModelPageSpec> =
  Extract<Spec["filter"][number], keyof PageRow<Spec>>

type PageRangeFields<Spec extends ReadModelPageSpec> =
  Extract<Spec["range"][number], keyof PageRow<Spec>>

type PageRequestFor<Spec extends ReadModelPageSpec> = Readonly<Partial<{
  filter: Readonly<Partial<Pick<PageRow<Spec>, PageFilterFields<Spec>>>>
  range: Readonly<Partial<{
    [Field in PageRangeFields<Spec>]: Readonly<Partial<{
      from: PageRow<Spec>[Field]
      to: PageRow<Spec>[Field]
    }>>
  }>>
  limit: number
  cursor: string
}>>

type RawCompiledPage = ReturnType<typeof compilePageDefinition>
type RawPageEffect = ReturnType<RawCompiledPage["handler"]>

type CompiledPageFor<Spec extends ReadModelPageSpec> =
  Omit<RawCompiledPage, "payload" | "success" | "handler"> & Readonly<{
    payload: Schema.Codec<PageRequestFor<Spec>, unknown>
    success: Schema.Codec<
      Page<PageRow<Spec>>,
      unknown,
      PageView<Spec>["schema"]["DecodingServices"],
      PageView<Spec>["schema"]["EncodingServices"]
    >
    handler: (
      input: PageRequestFor<Spec>,
    ) => Effect.Effect<
      Page<PageRow<Spec>>,
      Effect.Error<RawPageEffect>,
      SqlClient.SqlClient | PageView<Spec>["schema"]["DecodingServices"]
    >
  }>

const compileReadModelPage = <const Spec extends ReadModelPageSpec>(
  spec: Spec,
): CompiledPageFor<Spec> => {
  const view = compileReadModel(spec.model)
  type Field = ViewField<typeof view>

  return compilePageDefinition({
    view,
    filter: spec.filter as ReadonlyArray<Field>,
    range: spec.range as ReadonlyArray<Field>,
    order: spec.order as ReadonlyArray<readonly [Field, "asc" | "desc"]>,
    limit: spec.limit,
  }) as CompiledPageFor<Spec>
}

const publishReadModel = <
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
  const compiled = compileReadModelPage(definition.page)
  const { handler, ...contract } = compiled
  const spec = Command.define({
    name: definition.name,
    unavailable: definition.unavailable,
    ...contract,
  })

  return Command.implement(spec, handler)
}

export const ReadModel = {
  Schema: ReadModelSyntaxSchema,
  describe: describeReadModel,
  sources: readModelSources,
  define: defineReadModel,
  page: pageReadModel,
  compile: compileReadModel,
  compilePage: compileReadModelPage,
  publish: publishReadModel,
  fold: foldReadModel,
  map: mapReadModelF,
  DescriptionSchema: ReadModelDescriptionSchema,
}
