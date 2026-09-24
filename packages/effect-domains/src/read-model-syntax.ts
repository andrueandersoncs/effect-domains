import { Array, Data, Match, Record, Schema, Struct, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { PageLimitSchema } from "./domain.ts"
import type { ResourceSpec } from "./resource-definition.ts"
import type { ResourceTable } from "./resource-runtime.ts"
import { TableField } from "./physical-table-field.ts"
import type { Table } from "./table-relations.ts"

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

interface ColumnEvidence extends Schema.Schema.Type<typeof ColumnEvidenceSchema> {}

const TableEvidenceSchema = Schema.Struct({
  name: NameSchema,
  fields: Schema.Array(TableField),
  columns: Schema.Record(Schema.String, ColumnEvidenceSchema),
})

interface TableEvidence extends Schema.Schema.Type<typeof TableEvidenceSchema> {}


const DefinitionSchema = Schema.Struct({
  ...ReadModelDescription.fields,
  tables: Schema.Record(NameSchema, Schema.Unknown),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

class CompiledDefinition extends Data.Class<
  Omit<ReadModelDescription, "tables"> & Readonly<{ tables: CompiledTables }>
> {}

type ReadModelF<A> = Data.TaggedEnum<{
  Scan: {
    readonly alias: string
    readonly table: TableSource
  }
  Join: {
    readonly source: A
    readonly kind: "inner" | "left"
    readonly alias: string
    readonly table: TableSource
    readonly on: ReadonlyArray<Condition>
  }
  Project: {
    readonly source: A
    readonly select: Readonly<Record<string, Reference>>
  }
  Page: {
    readonly source: A
    readonly filter: ReadonlyArray<string>
    readonly range: ReadonlyArray<string>
    readonly order: ReadonlyArray<readonly [string, "asc" | "desc"]>
    readonly limit: number
  }
}>

type ReadModelSyntax = Data.TaggedEnum<{
  Scan: {
    readonly alias: string
    readonly table: TableSource
  }
  Join: {
    readonly source: ReadModelSyntax
    readonly kind: "inner" | "left"
    readonly alias: string
    readonly table: TableSource
    readonly on: ReadonlyArray<Condition>
  }
  Project: {
    readonly source: ReadModelSyntax
    readonly select: Readonly<Record<string, Reference>>
  }
  Page: {
    readonly source: ReadModelSyntax
    readonly filter: ReadonlyArray<string>
    readonly range: ReadonlyArray<string>
    readonly order: ReadonlyArray<readonly [string, "asc" | "desc"]>
    readonly limit: number
  }
}>

const ReadModelNodes = Data.taggedEnum<ReadModelSyntax>()

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
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    ReadModelLayer(ReadModelSyntaxSchema) as Schema.Codec<ReadModelSyntax>,
)

const transformReadModelF = <A, B>(
  layer: ReadModelF<A>,
  child: (value: A) => B,
): ReadModelF<B> => {
  const transformSource = (node: Exclude<ReadModelF<A>, { readonly _tag: "Scan" }>) => {
    const source = child(node.source)

    // SAFETY: The transformed node keeps its exact variant fields because only its recursive source changes from A to B.
    return Struct.assign(node, { source }) as Exclude<ReadModelF<B>, { readonly _tag: "Scan" }>
  }

  return pipe(
    Match.value(layer),
    Match.tag("Scan", (node) => node),
    Match.tag("Join", "Project", "Page", transformSource),
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

type LeftAlias<Joins> = Joins extends ReadonlyArray<infer Entry>
  ? Entry extends { readonly kind: "left"; readonly table: infer Key }
    ? Key
    : never
  : never

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
  { readonly [Key in keyof Selection]: SelectedField<Sources, Selection[Key]>["Encoded"] },
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

export {
  type Alias,
  CompiledDefinition,
  type CompiledSources,
  type Condition,
  ConditionSchema,
  DefinitionSchema,
  foldReadModel,
  type Join,
  type JoinFor,
  JoinSchema,
  type ReadModelAlgebra,
  ReadModelNodes,
  TableEvidenceSchema,
  type TableSource,
  transformReadModelF,
  type ReadModelSyntax,
  type Reference,
  type ReferenceFor,
  type SelectionFor,
  type Tables,
  type ViewSchema,
}