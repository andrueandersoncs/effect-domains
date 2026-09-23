import { Array, Data, Effect, Equivalence, Function, HashSet, Match, Option, Record, Schema, Struct, flow, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Resource } from "./resource.ts"
import { quoteIdentifier } from "./sqlite-ddl.ts"
import type { Table } from "./table.ts"

import {
  type Alias,
  CompiledDefinition,
  type CompiledReadModel,
  type CompiledSources,
  type Condition,
  ConditionSchema,
  DefinitionSchema,
  foldReadModel,
  type Join,
  type JoinFor,
  JoinSchema,
  type ReadModelAlgebra,
  ReadModelDescription,
  ReadModelNodes,
  type ReadModelSpec,
  type ReadModelSyntax,
  type Reference,
  type ReferenceFor,
  type SelectionFor,
  TableEvidenceSchema,
  type Tables,
  type TableSource,
  type ViewSchema,
} from "./read-model-syntax.ts"

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

const qualified = ([alias, field]: Reference) => `${quoteIdentifier(alias)}.${quoteIdentifier(field)}`
const freezeReference = ([alias, field]: Reference) => Object.freeze([alias, field] as const)
const isLeftJoin = (join: Join) => Equivalence.strictEqual<string>()(join.kind, "left")
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

    const sameFieldName = Equivalence.strictEqual<string>()
    const matchingField = Array.findFirst(table.fields, (candidate) => sameFieldName(candidate.name, field))

    const metadata = yield* pipe(
      matchingField,
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
      const leftJoined = Equivalence.strictEqual<string>()(leftAlias, join.table)
      const rightJoined = Equivalence.strictEqual<string>()(rightAlias, join.table)
      const prior = leftJoined ? rightAlias : leftAlias

      if (!HashSet.has(seen, prior)) return yield* definitionError(`join ${join.table} references an alias not yet introduced`)

      const left = yield* fieldFor(condition.left)
      const right = yield* fieldFor(condition.right)
      const sameScalar = Equivalence.strictEqual<string>()(left.metadata.scalar, right.metadata.scalar)
      const leftNumeric = !Equivalence.strictEqual<string>()(left.metadata.scalar, "string")
      const rightNumeric = !Equivalence.strictEqual<string>()(right.metadata.scalar, "string")
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
    const nonNullable = !nullable
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
    const kind = Equivalence.strictEqual<string>()(join.kind, "left") ? "LEFT JOIN" : "INNER JOIN"
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
  const compiledViewSchema = Schema.Struct(Record.map(result.projected, Struct.get("storageSchema")))
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
    // SAFETY: The schema has the selected view contract because each projected field contributes its own storage schema.
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    schema: compiledViewSchema as typeof compiledViewSchema & ViewSchema<Sources, Joins, Selection>,
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

  const scan = ReadModelNodes.Scan({
    alias: definition.from,
    table: source,
  })

  const joined = Array.reduce<JoinFor<Sources>, ReadModelSyntax>(
    definition.joins,
    scan,
    (syntax, join) => {
      const table = pipe(Record.get(definition.tables, join.table), Option.getOrThrow)

      return ReadModelNodes.Join({
        source: syntax,
        kind: join.kind,
        alias: join.table,
        table,
        // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
        on: join.on as ReadonlyArray<Condition>,
      })
    },
  )

  const syntax = ReadModelNodes.Project({
    source: joined,
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
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

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const compiled = compileDefinition(plan.definition as never)
  const dependencies = readModelDependencies(spec.syntax)

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  return Object.freeze({ ...compiled, dependencies }) as CompiledReadModelFor<Spec>
}

export {
  type CompiledReadModelFor,
  compileReadModel,
  definitionError,
  defineReadModel,
  describeReadModel,
  ReadModelInputError,
  readModelSources,
}
