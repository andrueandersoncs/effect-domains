import {
  Array,
  Brand,
  Context,
  Effect,
  Equivalence,
  flow,
  Option,
  pipe,
  Predicate,
  Record,
  Schema,
  SchemaAST,
  Struct,
} from "effect"
import { DomainIdentifier } from "./Domain.ts"

type AnyStruct = Schema.Struct<Schema.Struct.Fields>
type FieldName<S extends AnyStruct> = Extract<keyof S["fields"], string>

type IdentifierFieldName<S extends AnyStruct> = {
  [K in FieldName<S>]: S["fields"][K]["Type"] extends Brand.Brand<
    typeof DomainIdentifier
  > ? K
    : never
}[FieldName<S>]

const uuidV7Check = Schema.isUUID(7)

/**

Use when: describing generated table identity because tables without an explicit
domain identifier use the same validated UUIDv7 representation.

Example: use `DefaultTableIdentifierSchema` as an operation schema for a
generated table identifier.

**/
export const DefaultTableIdentifierSchema = Schema.String.check(uuidV7Check)

const DefaultIdentifierFields = Record.singleton(
  "id",
  DefaultTableIdentifierSchema,
)

const addDefaultIdentifierField = Schema.fieldsAssign(DefaultIdentifierFields)

type TableIdentifierName<S extends AnyStruct> =
  [IdentifierFieldName<S>] extends [never] ? "id" : IdentifierFieldName<S>

type TableRowFields<S extends AnyStruct> =
  [IdentifierFieldName<S>] extends [never]
    ? Readonly<typeof DefaultIdentifierFields> & S["fields"]
    : S["fields"]

type TableRowSchema<S extends AnyStruct> =
  [IdentifierFieldName<S>] extends [never]
    ? Schema.Struct<TableRowFields<S>>
    : S

type TableIdentifierSchema<S extends AnyStruct> =
  [IdentifierFieldName<S>] extends [never]
    ? typeof DefaultTableIdentifierSchema
    : S["fields"][IdentifierFieldName<S>]

/**

Use when: table derivation fails because invalid metadata must stop before
database work begins.

Example: handle this error when `Table.make` rejects a schema.

**/
// Keep a distinct definition error because it carries table and validation reason data.
export class TableDefinitionError extends Schema.TaggedError<TableDefinitionError>()(
  "TableDefinitionError",
  {
    table: Schema.String,
    reason: Schema.String,
  },
) {
  constructor(table: string, reason: string) {
    super({ table, reason })
  }

  override get message(): string {
    return `Invalid table definition for ${this.table}: ${this.reason}`
  }
}

const CreateTableOperationSchema = Schema.Literal("createTable")

/**

Use when: table creation fails because callers need the database cause in a
typed error channel.

Example: handle this error from `table.createTable()`.

**/
// Keep a distinct table error because it carries operation, table, and runtime cause data.
export class TableError extends Schema.TaggedError<TableError>()(
  "TableError",
  {
    operation: CreateTableOperationSchema,
    table: Schema.String,
    cause: Schema.Unknown,
  },
) {
  constructor(table: string, cause: unknown) {
    super({ operation: "createTable", table, cause })
  }

  override get message(): string {
    return `Table creation failed for ${this.table}`
  }
}

/**

Use when: rendering a table because adapters need validated physical column
metadata.

Example: map `TableField` values into SQL column definitions.

**/
export class TableField {
  constructor(
    readonly name: string,
    readonly scalar: "string" | "number",
    readonly generation: Option.Option<"uuidv7">,
  ) {}
}

const NoGeneration = Option.none<"uuidv7">()
const UuidV7Generation = Option.some<"uuidv7">("uuidv7")

const DefaultIdentifierField = new TableField(
  "id",
  "string",
  UuidV7Generation,
)

/**

Use when: inspecting a table because derived metadata and its creation Effect
must stay coupled.

Example: accept a `TableDefinition` in a database adapter.

**/
export abstract class TableDefinition<
  Name extends string,
  S extends AnyStruct,
  K extends string,
  Row extends AnyStruct,
  IdentifierSchema extends Schema.Constraint,
> {
  abstract readonly name: Name
  abstract readonly schema: S
  abstract readonly rowSchema: Row
  abstract readonly identifier: K
  abstract readonly identifierSchema: IdentifierSchema
  abstract readonly fields: ReadonlyArray<TableField>

  readonly createTable = Effect.fn("Table.createTable")(
    { self: this },
    function* (this: TableDefinition<Name, S, K, Row, IdentifierSchema>) {
      const store = yield* TableStore
      return yield* store.createTable(this)
    },
  )
}

/**

Use when: defining runtime table services because they accept every compiled
table definition.

Example: use this boundary in a `TableStore` implementation.

**/
export type AnyTableDefinition = TableDefinition<
  string,
  AnyStruct,
  string,
  AnyStruct,
  Schema.Constraint
>

/**

Use when: creating tables because definitions need a narrow runtime-provided
persistence interface.

Example: provide `TableStore` before running `table.createTable()`.

**/
export class TableStore extends Context.Service<TableStore, {
  readonly createTable: (
    table: AnyTableDefinition,
  ) => Effect.Effect<void, TableError>
}>()("@effect-domains/TableStore") {}

class MadeTable<
  Name extends string,
  S extends AnyStruct,
  K extends string,
  Row extends AnyStruct,
  IdentifierSchema extends Schema.Constraint,
> extends TableDefinition<Name, S, K, Row, IdentifierSchema> {
  constructor(
    readonly name: Name,
    readonly schema: S,
    readonly rowSchema: Row,
    readonly identifier: K,
    readonly identifierSchema: IdentifierSchema,
    readonly fields: ReadonlyArray<TableField>,
  ) {
    super()
  }
}

const compile = Effect.fn("Table.make")(function* <
  const Name extends string,
  S extends AnyStruct,
>(schema: S, name: Name) {
  const encodedSchema = Schema.toEncoded(schema)

  if (!SchemaAST.isObjects(encodedSchema.ast)) {
    return yield* new TableDefinitionError(
      name,
      "schema must encode to a flat struct",
    )
  }

  const hasIndexSignatures = encodedSchema.ast.indexSignatures.length > 0

  if (hasIndexSignatures) {
    return yield* new TableDefinitionError(
      name,
      "schema must encode to a flat struct",
    )
  }

  const compileField = Effect.fn("Table.compileField")(function* (
    property: (typeof encodedSchema.ast.propertySignatures)[number],
  ) {
    if (!Predicate.isString(property.name)) {
      return yield* new TableDefinitionError(
        name,
        "field names must be strings",
      )
    }

    if (SchemaAST.isOptional(property.type)) {
      return yield* new TableDefinitionError(
        name,
        `field ${property.name} must be required`,
      )
    }

    const isString = SchemaAST.isString(property.type)
    const isNumber = SchemaAST.isNumber(property.type)
    const isSupportedScalar = isString || isNumber

    if (!isSupportedScalar) {
      return yield* new TableDefinitionError(
        name,
        `field ${property.name} must encode to String or Number`,
      )
    }

    return new TableField(
      property.name,
      isString ? "string" : "number",
      NoGeneration,
    )
  })

  const fields = yield* Effect.forEach(
    encodedSchema.ast.propertySignatures,
    compileField,
  )

  const hasIdentifierAnnotation = (field: TableField): boolean => {
    const nullableFieldSchema = schema.fields[field.name]
    const fieldSchemaOption = Option.fromNullishOr(nullableFieldSchema)
    const fieldSchema = Option.getOrThrow(fieldSchemaOption)
    const resolvedAnnotations = Schema.resolveAnnotations(fieldSchema)
    const annotations = Option.fromNullishOr(resolvedAnnotations)
    const annotation = Option.map(annotations, Struct.get(DomainIdentifier))
    const isTrue = Equivalence.strictEqual<unknown>()

    return Option.containsWith(isTrue)(annotation, true)
  }

  const identifierFields = Array.filter(fields, hasIdentifierAnnotation)

  if (identifierFields.length > 1) {
    return yield* new TableDefinitionError(
      name,
      "schema must contain at most one Domain.identifier field",
    )
  }

  const identifierFieldOption = Array.get(identifierFields, 0)

  if (Option.isSome(identifierFieldOption)) {
    const identifierField = Option.getOrThrow(identifierFieldOption)

    const nullableIdentifierSchema =
      schema.fields[identifierField.name as FieldName<S>]

    const identifierSchemaOption = Option.fromNullishOr(nullableIdentifierSchema)
    const identifierSchema = Option.getOrThrow(identifierSchemaOption)

    return new MadeTable(
      name,
      schema,
      schema,
      identifierField.name,
      identifierSchema,
      fields,
    )
  }

  const fieldNameIsId = Equivalence.strictEqual<string>()
  const matchesId = (fieldName: string) => fieldNameIsId(fieldName, "id")

  const fieldIsReserved: (field: TableField) => boolean = flow(
    Struct.get("name"),
    matchesId,
  )

  const idIsReserved = Array.some(fields, fieldIsReserved)

  if (idIsReserved) {
    return yield* new TableDefinitionError(
      name,
      "field id must use Domain.identifier when overriding the default UUIDv7 identifier",
    )
  }

  const rowSchema = pipe(schema, addDefaultIdentifierField)

  return new MadeTable(
    name,
    schema,
    rowSchema,
    "id",
    rowSchema.fields.id,
    [DefaultIdentifierField, ...fields],
  )
})

/**

Use when: defining persistence because a canonical struct can mechanically
compile to one table definition. A missing domain identifier adds a generated
UUIDv7 `id` to the physical row schema.

Example: `Table.make(BookSchema, { name: "books" })` derives a table.

**/
export abstract class Table {
  static make<
    const Name extends string,
    const S extends AnyStruct,
  >(
    schema: S,
    config: Readonly<{ name: Name }>,
  ): TableDefinition<
    Name,
    S,
    TableIdentifierName<S>,
    TableRowSchema<S>,
    TableIdentifierSchema<S>
  > {
    const compiled = compile(schema, config.name)

    return Effect.runSync(compiled) as unknown as TableDefinition<
      Name,
      S,
      TableIdentifierName<S>,
      TableRowSchema<S>,
      TableIdentifierSchema<S>
    >
  }
}
