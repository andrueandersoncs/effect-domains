import { Array, Effect, Equivalence, Option, pipe } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { TableError } from "../table/errors.ts"
import { TableStore } from "../table/services.ts"
import type { TableField } from "../table/schemas.ts"

/**
 *
 * Scope: public
 *
 * When to use: A Bun SQLite runtime needs table rendering because compiled
 * scalar metadata must become SQL without domain semantics.
 *
 * Example:
 * ```ts
 * import { Effect } from "effect"
 * import { SqlClient } from "effect/unstable/sql"
 * import { tableStoreFromSqlclient } from "effect-domains/sqlite-bun/algorithms"
 *
 * const store = Effect.map(SqlClient.SqlClient, tableStoreFromSqlclient)
 * ```
 *
 */
export const tableStoreFromSqlclient = (sql: SqlClient.SqlClient) =>
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

        return sql`${sql(field.name)} ${columnType}${primaryKey} NOT NULL${generated} /* ${sql.literal(field._tag)} */`
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
