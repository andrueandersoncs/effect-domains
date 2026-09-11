import { Array, Record, Schema, Struct } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { Table } from "effect-domains/table"

type FieldName<TableDefinition extends Table> = Extract<
  keyof TableDefinition["rowSchema"]["fields"],
  string
>

const make = <
  const TableDefinition extends Table,
  const Fields extends ReadonlyArray<FieldName<TableDefinition>>,
>({ table, fields }: { readonly table: TableDefinition; readonly fields: Fields }) => {
  const selection = Object.freeze([...fields])
  const selected = Struct.pick(table.columns, selection)
  const StorageSchema = Schema.Struct(Record.map(selected, Struct.get("storageSchema")))

  const RowSchema = Schema.make<Schema.Codec<
    Pick<TableDefinition["rowSchema"]["Type"], Fields[number]>,
    Readonly<Record<Fields[number], unknown>>,
    TableDefinition["storageSchema"]["DecodingServices"],
    TableDefinition["storageSchema"]["EncodingServices"]
  >>(StorageSchema.ast)

  const object = (sql: SqlClient.SqlClient, alias: string) => {
    const entry = (field: Fields[number]) => sql`${field}, ${sql(alias)}.${sql(field)}`
    const entries = Array.map(selection, entry)
    return sql`json_object(${sql.csv(entries)})`
  }

  return { fields: selection, schema: RowSchema, json: Schema.fromJsonString(RowSchema), object }
}

export const NestedRow = { make }
