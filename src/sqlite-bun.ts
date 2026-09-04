import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Array, Context, Effect, Equivalence, Layer, Option, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { TableError, TableStore, type TableField } from "./table.ts"

export class Database extends Context.Service<Database, SqlClient.SqlClient>()(
  "@effect-domains/SqliteBun/Database",
) {}

const tableStoreFromSqlclient = (sql: SqlClient.SqlClient) =>
  TableStore.of({
    write: Effect.fn("TableStore.write")(function* (table) {
      const scalarIsString = Equivalence.strictEqual<"string" | "number">()
      const fieldIsIdentifier = Equivalence.strictEqual<string>()
      const generatedIsUuidV7 = Equivalence.strictEqual<"uuidv7">()

      const nameFromTablefield = (field: TableField) => {
        const columnType = scalarIsString(field.scalar, "string")
          ? sql.literal("TEXT")
          : sql.literal("REAL")

        const primaryKey = fieldIsIdentifier(field.name, table.identifier)
          ? sql.literal(" PRIMARY KEY")
          : sql.literal("")

        const isGeneratedUuidV7 = Option.containsWith(generatedIsUuidV7)(
          field.generation,
          "uuidv7",
        )

        const generated = isGeneratedUuidV7
          ? sql.literal(` DEFAULT (lower(
              substr(printf('%012x', cast(unixepoch('subsec') * 1000 as integer)), 1, 8) || '-' ||
              substr(printf('%012x', cast(unixepoch('subsec') * 1000 as integer)), 9, 4) || '-7' ||
              substr(hex(randomblob(2)), 2, 3) || '-' ||
              substr('89ab', (random() & 3) + 1, 1) ||
              substr(hex(randomblob(2)), 2, 3) || '-' ||
              hex(randomblob(6))
            ))`)
          : sql.literal("")

        return sql`${sql(field.name)} ${columnType}${primaryKey} NOT NULL${generated}`
      }

      const definitions = Array.map(table.fields, nameFromTablefield)
      const columns = sql.join(", ", true)(definitions)
      const statement = sql`CREATE TABLE ${sql(table.name)} ${columns}`

      return yield* pipe(
        statement,
        Effect.asVoid,
        Effect.mapError((cause) => new TableError(table.name, cause)),
      )
    }),
  })

const sqlClient = (filename: string) => {
  const clientLayer = SqliteClient.layer({ filename })

  const databaseLayer = pipe(
    Layer.effect(Database, SqlClient.SqlClient),
    Layer.provide(clientLayer),
  )

  const tableStoreLayer = pipe(
    Layer.effect(TableStore, Effect.map(Database, tableStoreFromSqlclient)),
    Layer.provide(databaseLayer),
  )

  return Layer.merge(databaseLayer, tableStoreLayer)
}

export const SqliteBunRuntime = {
  sqlClient,
}
