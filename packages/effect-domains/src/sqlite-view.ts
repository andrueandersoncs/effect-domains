import { Array, Context, Effect, Equivalence, Function, HashSet, Match, Option, Record, Schema, SchemaAST, Struct, flow, pipe } from "effect"
import type { SqlClient } from "effect/unstable/sql"
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

const ColumnEvidenceSchema = Schema.Struct({ storageSchema: Schema.declare<Schema.Constraint>(Schema.isSchema) })

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
>

export interface SqliteView {
  readonly description: Description
  readonly dependencies: ReadonlyArray<Table>
}

class SqliteViewAnnotation extends Context.Service<SqliteViewAnnotation, ReadonlyArray<SqliteView>>()("@effect-domains/SqliteView") {}

class SqliteViewDefinitionError extends Schema.TaggedError<SqliteViewDefinitionError>()("SqliteViewDefinitionError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Invalid SQLite view definition: ${this.reason}`
  }
}

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

    return { metadata, storage: column.storageSchema }
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

    const StorageSchema = nullable ? Schema.NullOr(field.storage) : field.storage
    return [output, StorageSchema] as const
  }))

  const schemas = Record.fromEntries(fields)
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

  return { schema: ResultSchema, description, dependencies, select, column }
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
  return Object.freeze({ ...result, schema: result.schema as ViewSchema<Sources, Joins, Selection>, column })
}

export const SqliteView = { annotation: SqliteViewAnnotation, make }
