import { Context, Effect, Option, Schema, SchemaAST } from "effect"

export type StorageScalar = string | number
export type StorageRow = Readonly<Record<string, StorageScalar>>

export class PersistenceCatalogError extends Error {
  readonly _tag = "PersistenceCatalogError"

  constructor(readonly entity: string, message: string) {
    super(`Invalid persistence declaration for ${entity}: ${message}`)
  }
}

export class PersistenceError extends Error {
  readonly _tag = "PersistenceError"

  constructor(
    readonly operation: "create" | "read" | "update" | "delete",
    readonly entity: string,
    override readonly cause: unknown,
  ) {
    super(`Persistence ${operation} failed for ${entity}`, { cause })
  }
}

type AnyStruct = Schema.Struct<Schema.Struct.Fields>
type FieldName<S extends AnyStruct> = Extract<keyof S["fields"], string>
type Domain<S extends AnyStruct> = S["Type"]
type KeySchema<
  S extends AnyStruct,
  K extends FieldName<S>,
> = S["fields"][K]
type KeyType<
  S extends AnyStruct,
  K extends FieldName<S>,
> = KeySchema<S, K>["Type"]

type LooseEntityDeclaration = Readonly<{
  schema: AnyStruct
  table: string
  primaryKey: string
  columns?: Readonly<Partial<Record<string, string>>>
}>

export type PersistenceCatalog = Readonly<Record<string, LooseEntityDeclaration>>

type ValidateEntity<E> = Exclude<
  keyof E,
  "schema" | "table" | "primaryKey" | "columns"
> extends never
  ? E extends {
    readonly schema: infer S extends AnyStruct
    readonly primaryKey: infer K extends string
    readonly columns?: infer C
  }
    ? K extends FieldName<S>
      ? Exclude<keyof NonNullable<C>, FieldName<S>> extends never
        ? unknown
        : never
      : never
    : never
  : never

type ValidateCatalog<C extends PersistenceCatalog> = {
  readonly [Name in keyof C]: ValidateEntity<C[Name]>
}

export const definePersistenceCatalog = <const C extends PersistenceCatalog>(
  catalog: C & ValidateCatalog<C>,
): C => catalog

export interface EncodedRowStore {
  readonly create: (
    row: StorageRow,
  ) => Effect.Effect<StorageRow, PersistenceError>
  readonly read: (
    key: StorageScalar,
  ) => Effect.Effect<Option.Option<StorageRow>, PersistenceError>
  readonly update: (
    row: StorageRow,
  ) => Effect.Effect<Option.Option<StorageRow>, PersistenceError>
  readonly delete: (
    key: StorageScalar,
  ) => Effect.Effect<boolean, PersistenceError>
}

declare const EntityServiceTypeId: unique symbol

export interface EntityService<
  Name extends string,
  S = unknown,
  K = unknown,
> {
  readonly [EntityServiceTypeId]: {
    readonly entity: Name
    readonly schema: S
    readonly primaryKey: K
  }
}

export interface CompiledField {
  readonly field: string
  readonly column: string
  readonly scalar: "string" | "number"
}

export interface CompiledEntity<
  Name extends string,
  S extends AnyStruct,
  K extends FieldName<S>,
> {
  readonly name: Name
  readonly schema: S
  readonly table: string
  readonly primaryKey: K
  readonly primaryKeyColumn: string
  readonly fields: ReadonlyArray<CompiledField>
  readonly Service: Context.Service<EntityService<Name, S, K>, EncodedRowStore>
  readonly create: (
    entity: Domain<S>,
  ) => Effect.Effect<
    Domain<S>,
    PersistenceError | Schema.SchemaError,
    EntityService<Name, S, K> | S["EncodingServices"] | S["DecodingServices"]
  >
  readonly read: (
    key: KeyType<S, K>,
  ) => Effect.Effect<
    Option.Option<Domain<S>>,
    PersistenceError | Schema.SchemaError,
    | EntityService<Name, S, K>
    | KeySchema<S, K>["EncodingServices"]
    | S["DecodingServices"]
  >
  readonly update: (
    entity: Domain<S>,
  ) => Effect.Effect<
    Option.Option<Domain<S>>,
    PersistenceError | Schema.SchemaError,
    EntityService<Name, S, K> | S["EncodingServices"] | S["DecodingServices"]
  >
  readonly delete: (
    key: KeyType<S, K>,
  ) => Effect.Effect<
    boolean,
    PersistenceError | Schema.SchemaError,
    EntityService<Name, S, K> | KeySchema<S, K>["EncodingServices"]
  >
}

type CompiledEntityOf<Name extends string, D extends LooseEntityDeclaration> =
  D extends { readonly schema: infer S extends AnyStruct }
    ? D extends { readonly primaryKey: infer K extends FieldName<S> }
      ? CompiledEntity<Name, S, K>
      : never
    : never

export type CompiledPersistenceCatalog<C extends PersistenceCatalog> = {
  readonly [Name in keyof C]: CompiledEntityOf<Extract<Name, string>, C[Name]>
}

const inspectFields = (
  entity: string,
  declaration: LooseEntityDeclaration,
): ReadonlyArray<CompiledField> => {
  const encoded = Schema.toEncoded(declaration.schema).ast
  if (!SchemaAST.isObjects(encoded) || encoded.indexSignatures.length > 0) {
    throw new PersistenceCatalogError(entity, "schema must encode to a flat struct")
  }

  const fields = encoded.propertySignatures.map((property) => {
    if (typeof property.name !== "string") {
      throw new PersistenceCatalogError(entity, "field names must be strings")
    }
    if (SchemaAST.isOptional(property.type)) {
      throw new PersistenceCatalogError(entity, `field ${property.name} must be required`)
    }
    if (!SchemaAST.isString(property.type) && !SchemaAST.isNumber(property.type)) {
      throw new PersistenceCatalogError(
        entity,
        `field ${property.name} must encode to String or Number`,
      )
    }
    return {
      field: property.name,
      column: declaration.columns?.[property.name] ?? property.name,
      scalar: SchemaAST.isString(property.type) ? "string" : "number",
    } as const
  })

  if (!fields.some((field) => field.field === declaration.primaryKey)) {
    throw new PersistenceCatalogError(entity, "primary key must name an encoded field")
  }

  const columns = new Set<string>()
  for (const field of fields) {
    if (columns.has(field.column)) {
      throw new PersistenceCatalogError(entity, `duplicate column ${field.column}`)
    }
    columns.add(field.column)
  }

  return fields
}

const toStorageRow = (
  fields: ReadonlyArray<CompiledField>,
  encoded: object,
): StorageRow => {
  const input = encoded as Readonly<Record<string, unknown>>
  const row: Record<string, StorageScalar> = {}
  for (const field of fields) {
    row[field.field] = input[field.field] as StorageScalar
  }
  return row
}

const fromStorageRow = (
  fields: ReadonlyArray<CompiledField>,
  row: StorageRow,
): Record<string, StorageScalar> => {
  const encoded: Record<string, StorageScalar> = {}
  for (const field of fields) {
    encoded[field.field] = row[field.field]!
  }
  return encoded
}

const compileEntity = <
  const Name extends string,
  S extends AnyStruct,
  K extends FieldName<S>,
>(
  name: Name,
  declaration: Readonly<{
    schema: S
    table: string
    primaryKey: K
    columns?: Readonly<Partial<Record<FieldName<S>, string>>>
  }>,
): CompiledEntity<Name, S, K> => {
  const fields = inspectFields(name, declaration)
  const primaryKeyColumn = fields.find(
    (field) => field.field === declaration.primaryKey,
  )!.column
  const Service = Context.Service<EntityService<Name, S, K>, EncodedRowStore>(
    `@effect-domains/persistence/${name}`,
  )
  const encodeEntity = Schema.encodeEffect(declaration.schema)
  const decodeEntity = Schema.decodeUnknownEffect(declaration.schema)
  const keySchema = declaration.schema.fields[declaration.primaryKey]!
  const encodeKey = Schema.encodeEffect(keySchema)

  const decodeRow = (row: StorageRow) =>
    decodeEntity(fromStorageRow(fields, row))

  return {
    name,
    schema: declaration.schema,
    table: declaration.table,
    primaryKey: declaration.primaryKey,
    primaryKeyColumn,
    fields,
    Service,
    create: (entity) =>
      Effect.flatMap(encodeEntity(entity), (encoded) =>
        Service.use((store) =>
          Effect.flatMap(
            store.create(toStorageRow(fields, encoded)),
            decodeRow,
          )
        )
      ),
    read: (key) =>
      Effect.flatMap(encodeKey(key), (encodedKey) =>
        Service.use((store) =>
          Effect.flatMap(store.read(encodedKey as StorageScalar), (row) =>
            Option.isSome(row)
              ? Effect.map(decodeRow(row.value), Option.some)
              : Effect.succeedNone
          )
        )
      ),
    update: (entity) =>
      Effect.flatMap(encodeEntity(entity), (encoded) =>
        Service.use((store) =>
          Effect.flatMap(store.update(toStorageRow(fields, encoded)), (row) =>
            Option.isSome(row)
              ? Effect.map(decodeRow(row.value), Option.some)
              : Effect.succeedNone
          )
        )
      ),
    delete: (key) =>
      Effect.flatMap(encodeKey(key), (encodedKey) =>
        Service.use((store) => store.delete(encodedKey as StorageScalar))
      ),
  }
}

export const compilePersistenceCatalog = <const C extends PersistenceCatalog>(
  catalog: C,
): Effect.Effect<CompiledPersistenceCatalog<C>, PersistenceCatalogError> =>
  Effect.try({
    try: () => {
      const compiled: Record<string, unknown> = {}
      for (const [name, declaration] of Object.entries(catalog)) {
        compiled[name] = compileEntity(name, declaration as any)
      }
      return compiled as CompiledPersistenceCatalog<C>
    },
    catch: (cause) =>
      cause instanceof PersistenceCatalogError
        ? cause
        : new PersistenceCatalogError("catalog", String(cause)),
  })
