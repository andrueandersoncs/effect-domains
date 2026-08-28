import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import {
  type CompiledEntity,
  type CompiledPersistenceCatalog,
  type EncodedRowStore,
  type EntityService,
  PersistenceError,
  type PersistenceCatalog,
  type StorageRow,
  type StorageScalar,
} from "./Persistence.ts"

export interface SqliteBunOptions {
  readonly filename: string
}

type AnyCompiledEntity = CompiledEntity<string, any, string>
type DatabaseRow = Record<string, StorageScalar>
type RawRow = Readonly<Record<string, unknown>>

type EntityRequirement<E> = E extends CompiledEntity<
  infer Name,
  infer S,
  infer K
> ? EntityService<Name, S, K>
  : never

type CatalogRequirement<C extends PersistenceCatalog> = EntityRequirement<
  CompiledPersistenceCatalog<C>[keyof C]
>

const mapFailure = (
  entity: AnyCompiledEntity,
  operation: "create" | "read" | "update" | "delete",
) => (cause: unknown): PersistenceError =>
  new PersistenceError(operation, entity.name, cause)

const makeStore = (
  sql: SqlClient.SqlClient,
  entity: AnyCompiledEntity,
): EncodedRowStore => {
  const toDatabase = (row: StorageRow): DatabaseRow =>
    Object.fromEntries(
      entity.fields.map(({ field, column }) => [column, row[field]!]),
    )

  const fromDatabase = (row: RawRow): StorageRow =>
    Object.fromEntries(
      entity.fields.map(({ field, column }) => [field, row[column]]),
    ) as StorageRow

  const first = (rows: ReadonlyArray<RawRow>) =>
    Option.map(Option.fromUndefinedOr(rows[0]), fromDatabase)

  return entity.Service.of({
    create: (row) =>
      sql<RawRow>`INSERT INTO ${sql(entity.table)} ${sql.insert(toDatabase(row))} RETURNING *`.pipe(
        Effect.map((rows) => fromDatabase(rows[0]!)),
        Effect.mapError(mapFailure(entity, "create")),
      ),
    read: (key) =>
      sql<RawRow>`SELECT * FROM ${sql(entity.table)} WHERE ${sql(entity.primaryKeyColumn)} = ${key} LIMIT 1`.pipe(
        Effect.map(first),
        Effect.mapError(mapFailure(entity, "read")),
      ),
    update: (row) => {
      const databaseRow = toDatabase(row)
      return sql<RawRow>`UPDATE ${sql(entity.table)} SET ${sql.update(databaseRow, [entity.primaryKeyColumn])} WHERE ${sql(entity.primaryKeyColumn)} = ${databaseRow[entity.primaryKeyColumn]} RETURNING *`.pipe(
        Effect.map(first),
        Effect.mapError(mapFailure(entity, "update")),
      )
    },
    delete: (key: StorageScalar) =>
      sql<RawRow>`DELETE FROM ${sql(entity.table)} WHERE ${sql(entity.primaryKeyColumn)} = ${key} RETURNING ${sql(entity.primaryKeyColumn)}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(mapFailure(entity, "delete")),
      ),
  })
}

export const layer = <const C extends PersistenceCatalog>(
  catalog: CompiledPersistenceCatalog<C>,
  options: SqliteBunOptions,
): Layer.Layer<CatalogRequirement<C>> => {
  const entityLayers = Object.values(catalog).map((entity) =>
    Layer.effect(
      entity.Service,
      SqlClient.SqlClient.use((sql) =>
        Effect.succeed(makeStore(sql, entity as AnyCompiledEntity))
      ),
    )
  )

  return Layer.mergeAll(Layer.empty, ...entityLayers).pipe(
    Layer.provide(SqliteClient.layer({ filename: options.filename })),
  ) as Layer.Layer<CatalogRequirement<C>>
}
