import { Array, Record, Schema, Struct, pipe } from "effect"
import type { TableReference } from "./table-relation-input.ts"
import type { Table } from "./table-relations.ts"

type ProjectedField<TableDefinition extends Table> = Extract<keyof TableDefinition["rowSchema"]["fields"], string>

type StorageEncoded<Column> = Column extends {
  readonly storageSchema: { readonly Encoded: infer Encoded }
}
  ? Encoded
  : never

const reference = <
  const Target extends Table,
  const Fields extends ReadonlyArray<Extract<keyof Target["rowSchema"]["fields"], string>>,
>(table: Target, fields: Fields): TableReference => {
  const copiedFields = Array.copy(fields)
  const frozenFields = Object.freeze(copiedFields)

  return Object.freeze({ table, fields: frozenFields })
}

const project = <
  const TableDefinition extends Table,
  const Fields extends ReadonlyArray<ProjectedField<TableDefinition>>,
>(table: TableDefinition, fields: Fields) => {
  const selection = Object.freeze([...fields])
  const selected = Struct.pick(table.columns, selection)

  const ProjectionSchema = Schema.make<Schema.Codec<
    Pick<TableDefinition["rowSchema"]["Type"], Fields[number]>,
    { readonly [Key in Fields[number]]: StorageEncoded<TableDefinition["columns"][Key]> },
    TableDefinition["storageSchema"]["DecodingServices"],
    TableDefinition["storageSchema"]["EncodingServices"]
  >>(pipe(
    Record.map(selected, ({ storageSchema }) => storageSchema),
    Schema.Struct,
    Struct.get<Schema.Top, "ast">("ast"),
  ))

  const object = (sql: import("effect/unstable/sql").SqlClient.SqlClient, alias: string) => {
    const entry = (field: Fields[number]) => sql`${field}, ${sql(alias)}.${sql(field)}`
    const entries = Array.map(selection, entry)

    return sql`json_object(${sql.csv(entries)})`
  }

  return {
    fields: selection,
    schema: ProjectionSchema,
    json: Schema.fromJsonString(ProjectionSchema),
    object,
  }
}

export { project, reference }
