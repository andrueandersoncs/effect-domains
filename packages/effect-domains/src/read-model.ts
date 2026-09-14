import { Array, Data, Effect, Equivalence, Function, HashSet, Match, Option, Record, Schema, Struct, Tuple, flow, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { PageLimitSchema } from "./domain.ts"
import { Page } from "./page.ts"
import { Command } from "./command.ts"
import { Resource, type ResourceSpec, type ResourceTable } from "./resource.ts"
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
const DescriptionTablesSchema = Schema.Record(NameSchema, NameSchema)
const DescriptionJoinsSchema = Schema.Array(JoinSchema)

export class ReadModelDescription extends Schema.Class<ReadModelDescription>("ReadModelDescription")({
  tables: DescriptionTablesSchema,
  from: NameSchema,
  joins: DescriptionJoinsSchema,
  select: SelectionSchema,
}) {}

interface Join extends Schema.Schema.Type<typeof JoinSchema> {}
interface Condition extends Schema.Schema.Type<typeof ConditionSchema> {}
type Reference = Schema.Schema.Type<typeof ReferenceSchema>
type TableSource = Table | ResourceSpec
type Tables = Readonly<Record<string, TableSource>>
type CompiledTables = Readonly<Record<string, Table>>

type SourceTable<Source extends TableSource> =
  Source extends ResourceSpec ? ResourceTable<Source> : Source

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
  ...ReadModelDescription.fields,
  tables: Schema.Record(NameSchema, Schema.Unknown),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

class CompiledDefinition extends Data.Class<
  Omit<ReadModelDescription, "tables"> & Readonly<{ tables: CompiledTables }>
> {}

type ReadModelF<A> =
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

type ReadModelSyntax =
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

const ScanSyntaxSchema = Schema.TaggedStruct("Scan", {
  alias: NameSchema,
  table: Schema.Unknown,
})

const ReadModelLayer = <A, E>(child: Schema.Codec<A, E>) => {
  const JoinSyntaxSchema = Schema.TaggedStruct("Join", {
    source: child,
    kind: Schema.Literals(["inner", "left"]),
    alias: NameSchema,
    table: Schema.Unknown,
    on: Schema.Array(ConditionSchema),
  })

  const ProjectSyntaxSchema = Schema.TaggedStruct("Project", {
    source: child,
    select: SelectionSchema,
  })

  const PageSyntaxSchema = Schema.TaggedStruct("Page", {
    source: child,
    filter: Schema.Array(NameSchema),
    range: Schema.Array(NameSchema),
    order: Schema.Array(Schema.Tuple([NameSchema, Schema.Literals(["asc", "desc"])])),
    limit: PageLimitSchema,
  })

  return Schema.Union([ScanSyntaxSchema, JoinSyntaxSchema, ProjectSyntaxSchema, PageSyntaxSchema])
}

export const ReadModelSyntaxSchema: Schema.Codec<ReadModelSyntax> = Schema.suspend(
  (): Schema.Codec<ReadModelSyntax> =>
    ReadModelLayer(ReadModelSyntaxSchema) as Schema.Codec<ReadModelSyntax>,
)

const transformReadModelF = <A, B>(
  layer: ReadModelF<A>,
  child: (value: A) => B,
): ReadModelF<B> => {
  const transformJoin = (node: Extract<ReadModelF<A>, { readonly _tag: "Join" }>) => {
    const source = child(node.source)
    return Struct.assign(node, { source })
  }

  const transformProject = (node: Extract<ReadModelF<A>, { readonly _tag: "Project" }>) => {
    const source = child(node.source)
    return Struct.assign(node, { source })
  }

  const transformPage = (node: Extract<ReadModelF<A>, { readonly _tag: "Page" }>) => {
    const source = child(node.source)
    return Struct.assign(node, { source })
  }

  return pipe(
    Match.value(layer),
    Match.tag("Scan", (node) => node),
    Match.tag("Join", transformJoin),
    Match.tag("Project", transformProject),
    Match.tag("Page", transformPage),
    Match.exhaustive,
  )
}

type ReadModelAlgebra<A> = (layer: ReadModelF<A>) => A

const foldReadModel = <A>(algebra: ReadModelAlgebra<A>) => {
  const interpret = (syntax: ReadModelSyntax) =>
    pipe(transformReadModelF<ReadModelSyntax, A>(syntax, interpret), algebra)

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

type ListableSchema = Schema.Constraint & Readonly<{
  fields: Readonly<Record<string, Schema.Constraint>>
}>

export interface CompiledReadModel<
  View extends ListableSchema = ListableSchema,
  Ref extends Reference = Reference,
> {
  readonly _tag: "CompiledReadModel"
  readonly description: ReadModelDescription
  readonly dependencies: ReadonlyArray<Table>
  readonly schema: View
  readonly projected: Readonly<Record<string, Readonly<{ orderable: boolean }>>>
  readonly column: (
    sql: SqlClient.SqlClient,
    reference: Ref,
  ) => ReturnType<SqlClient.SqlClient["literal"]>
  readonly select: (sql: SqlClient.SqlClient) => ReturnType<SqlClient.SqlClient["literal"]>
  readonly outputField: (
    sql: SqlClient.SqlClient,
    field: string,
  ) => ReturnType<SqlClient.SqlClient["literal"]>
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

const compile = Effect.fn("ReadModel.compile")(function* (definition: CompiledDefinition) {
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
  const description = ReadModelDescription.make({ tables, from: input.from, joins, select: selection })
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
}>): CompiledReadModel<ViewSchema<Sources, Joins, Selection>, ReferenceFor<Sources>> => {
  const { tables, from, joins, select } = definition
  const compiledDefinition = new CompiledDefinition({ tables, from, joins, select })
  const compilation = compile(compiledDefinition)
  const result = Effect.runSync(compilation)
  const column = (sql: SqlClient.SqlClient, reference: ReferenceFor<Sources>) => result.column(sql, reference)

  const outputField = (sql: SqlClient.SqlClient, field: string) => pipe(
    Record.get(result.projected, field),
    Option.map(Struct.get("reference")),
    Option.getOrThrow,
    (reference) => result.column(sql, reference),
  )


  return Object.freeze({
    _tag: "CompiledReadModel" as const,
    description: result.description,
    column,
    dependencies: result.dependencies,
    outputField,
    projected: result.projected,
    schema: result.schema as ViewSchema<Sources, Joins, Selection>,
    select: result.select,
  })
}

class PageConfiguration extends Data.Class<{
  readonly filter: ReadonlyArray<string>
  readonly range: ReadonlyArray<string>
  readonly order: ReadonlyArray<readonly [string, "asc" | "desc"]>
  readonly limit: number
}> {}

class ReadModelPlan extends Data.Class<{
  readonly definition: CompiledDefinition
  readonly page: Option.Option<PageConfiguration>
}> {}

const emptySelection: Readonly<Record<string, Reference>> = Object.freeze({})
const noPage = Option.none<PageConfiguration>()

const compileSource = pipe(
  Match.type<TableSource>(),
  Match.tagsExhaustive({
    Table: (table) => table,
    ResourceSpec: Resource.table,
  }),
)

const planAlgebra: ReadModelAlgebra<ReadModelPlan> = (layer) => pipe(
  Match.value(layer),
  Match.tagsExhaustive({
    Scan: ({ alias, table }) => {
      const compiledTable = compileSource(table)
      const tables = Record.singleton(alias, compiledTable)

      const definition = new CompiledDefinition({
        tables,
        from: alias,
        joins: [],
        select: emptySelection,
      })

      return new ReadModelPlan({ definition, page: noPage })
    },
    Join: ({ source, kind, alias, table, on }) => {
      const compiledTable = compileSource(table)
      const tables = Record.set(source.definition.tables, alias, compiledTable)
      const join = JoinSchema.make({ kind, table: alias, on })
      const joins = Array.append(source.definition.joins, join)
      const definition = new CompiledDefinition({ ...source.definition, tables, joins })

      return new ReadModelPlan({ definition, page: source.page })
    },
    Project: ({ source, select }) => {
      const definition = new CompiledDefinition({ ...source.definition, select })
      return new ReadModelPlan({ definition, page: source.page })
    },
    Page: ({ source, filter, range, order, limit }) => {
      const page = new PageConfiguration({ filter, range, order, limit })
      const configuredPage = Option.some(page)
      return new ReadModelPlan({ definition: source.definition, page: configuredPage })
    },
  }),
)

const dependencyAlgebra: ReadModelAlgebra<ReadonlyArray<Table>> = (layer) => pipe(
  Match.value(layer),
  Match.tagsExhaustive({
    Scan: ({ table }) => [compileSource(table)],
    Join: ({ source, table }) => {
      const dependency = compileSource(table)
      const dependencies = Array.append(source, dependency)
      return Array.dedupeWith(dependencies, Equivalence.strictEqual<Table>())
    },
    Project: ({ source }) => source,
    Page: ({ source }) => source,
  }),
)

const compilePlan = foldReadModel(planAlgebra)
const readModelDependencies = foldReadModel(dependencyAlgebra)

const describeReadModel = (spec: ReadModelSpec): ReadModelDescription => {
  const plan = compilePlan(spec.syntax)

  return ReadModelDescription.make({
    ...plan.definition,
    tables: Record.map(plan.definition.tables, Struct.get("name")),
  })
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

  const scan = ReadModelSyntaxSchema.make({
    _tag: "Scan",
    alias: definition.from,
    table: source,
  })

  const joined = Array.reduce<JoinFor<Sources>, ReadModelSyntax>(
    definition.joins,
    scan,
    (syntax, join) => ReadModelSyntaxSchema.make({
      _tag: "Join",
      source: syntax,
      kind: join.kind,
      alias: join.table,
      table: pipe(Record.get(definition.tables, join.table), Option.getOrThrow),
      on: join.on as ReadonlyArray<Condition>,
    }),
  )

  const syntax = ReadModelSyntaxSchema.make({
    _tag: "Project",
    source: joined,
    select: definition.select as Readonly<Record<string, Reference>>,
  })

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



const compileReadModel = <const Spec extends ReadModelSpec>(
  spec: Spec,
): CompiledReadModelFor<Spec> => {
  const plan = compilePlan(spec.syntax)
  const declaredAliases = Record.keys(spec.definition.tables)
  const validateAliases = uniqueNames("table alias")
  const aliasValidation = validateAliases(declaredAliases)
  Effect.runSync(aliasValidation)

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
  const view = compileReadModel(spec.model) as PageView<Spec>
  type View = PageView<Spec>
  type Filter = PageFilter<Spec>
  type Range = PageRange<Spec>

  const copiedFilterFields = Array.fromIterable(
    spec.filter as ReadonlyArray<ViewField<View>>,
  )

  const filterFields = Object.freeze(copiedFilterFields)

  const copiedRangeFields = Array.fromIterable(
    spec.range as ReadonlyArray<ViewField<View>>,
  )

  const rangeFields = Object.freeze(copiedRangeFields)

  const copiedOrderSource = Array.fromIterable(
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
  const SuccessShapeSchema = Page.schema(CanonicalRowSchema)

  const successSchema = Schema.make<Schema.Codec<
    Readonly<{ items: ReadonlyArray<View["schema"]["Type"]>; nextCursor: string | null }>,
    typeof SuccessShapeSchema.Encoded,
    typeof SuccessShapeSchema.DecodingServices,
    typeof SuccessShapeSchema.EncodingServices
  >>(SuccessShapeSchema.ast)

  const decodeRows = Schema.decodeUnknownEffect(Schema.Array(view.schema))

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

    const column = (field: string) => view.outputField(sql, field)

    const rendered = SqliteList.render(
      sql,
      column,
      prepared.query,
    )

    const rows = yield* sql<Readonly<Record<string, unknown>>>`
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
    handler: execute as (
      input: ViewListRequest<View, Filter, Range>
    ) => Effect.Effect<typeof successSchema.Type, Effect.Error<ReturnType<typeof execute>>, HandlerRequirements>,
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

export const ReadModel = {
  Schema: ReadModelSyntaxSchema,
  describe: describeReadModel,
  sources: readModelSources,
  define: defineReadModel,
  page: pageReadModel,
  compile: compileReadModel,
  compilePage: compileReadModelPage,
  publish: commandFromPage,
  fold: foldReadModel,
  map: transformReadModelF,
  DescriptionSchema: ReadModelDescription,
}
