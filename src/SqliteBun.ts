import { Array, Effect, Equivalence, Function, Layer, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import {
  type AnyTableDefinition,
  TableError,
  type TableField,
  TableStore,
} from "./Table.ts"

/** The database service available to authored query Effects. */
export const Database = SqlClient.SqlClient
export type Database = SqlClient.SqlClient

export class SqliteBunOptions {
  constructor(readonly filename: string) {}
}

const tableStore = (sql: SqlClient.SqlClient) =>
  TableStore.of({
    createTable: (table: AnyTableDefinition) => {
      const scalarIsString = Equivalence.strictEqual<"string" | "number">()
      const fieldIsIdentifier = Equivalence.strictEqual<string>()

      const columnDefinition = (field: TableField) => {
        const columnType = scalarIsString(field.scalar, "string")
          ? sql.literal("TEXT")
          : sql.literal("REAL")

        const primaryKey = fieldIsIdentifier(field.name, table.identifier)
          ? sql.literal(" PRIMARY KEY")
          : sql.literal("")

        return sql`${sql(field.name)} ${columnType}${primaryKey} NOT NULL`
      }

      const definitions = Array.map(table.fields, columnDefinition)
      const columns = sql.join(", ", true)(definitions)
      const statement = sql`CREATE TABLE ${sql(table.name)} ${columns}`

      return pipe(
        statement,
        Effect.asVoid,
        Effect.mapError((cause) => new TableError(table.name, cause)),
      )
    },
  })

/** Supplies both table creation and the database required by authored queries. */
export const layer = (options: SqliteBunOptions) => {
  const databaseLayer = SqliteClient.layer(options)
  const storeEffect = SqlClient.SqlClient.use(
    Function.compose(tableStore, Effect.succeed),
  )
  const storeLayer = pipe(
    Layer.effect(TableStore, storeEffect),
    Layer.provide(databaseLayer),
  )

  return Layer.merge(databaseLayer, storeLayer)
}
