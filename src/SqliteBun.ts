import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Array, Effect, Equivalence, Function, Layer, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  TableError,
  type TableField,
  TableStore,
} from "./Table.ts"

/**

Use when: authoring query Effects because this service provides the runtime
SQL client.

Example: `const db = yield* Database` accesses the active client.

**/
export const Database = SqlClient.SqlClient

/**

Use when: declaring Effect requirements because this type names the runtime
SQL service.

Example: include `Database` in an authored query's requirement channel.

**/
export type Database = SqlClient.SqlClient

/**

Use when: building the Bun SQLite layer because it needs a database filename.

Example: `new SqliteBunOptions("app.sqlite")` targets a database file.

**/
export class SqliteBunOptions {
  constructor(readonly filename: string) {}
}

const tableStore = (sql: SqlClient.SqlClient) =>
  TableStore.of({
    createTable: (table) => {
      const scalarIsString = Equivalence.strictEqual<"string" | "number">()
      const fieldIsIdentifier = Equivalence.strictEqual<string>()

      const columnNameFromTablefield = (field: TableField) => {
        const columnType = scalarIsString(field.scalar, "string")
          ? sql.literal("TEXT")
          : sql.literal("REAL")

        const primaryKey = fieldIsIdentifier(field.name, table.identifier)
          ? sql.literal(" PRIMARY KEY")
          : sql.literal("")

        return sql`${sql(field.name)} ${columnType}${primaryKey} NOT NULL`
      }

      const definitions = Array.map(table.fields, columnNameFromTablefield)
      const columns = sql.join(", ", true)(definitions)
      const statement = sql`CREATE TABLE ${sql(table.name)} ${columns}`

      return pipe(
        statement,
        Effect.asVoid,
        Effect.mapError((cause) => new TableError(table.name, cause)),
      )
    },
  })

/**

Use when: running table and query Effects because the layer supplies table
creation and the SQL client together.

Example: provide `layer(options)` to an application Effect.

**/
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
