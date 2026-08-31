import {
  Array,
  Brand,
  Context,
  Effect,
  Equivalence,
  Option,
  Predicate,
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
  ) {}
}

/**

Use when: inspecting a table because derived metadata and its creation Effect
must stay coupled.

Example: accept a `TableDefinition` in a database adapter.

**/
export abstract class TableDefinition<
  Name extends string,
  S extends AnyStruct,
  K extends FieldName<S>,
> {
  abstract readonly name: Name
  abstract readonly schema: S
  abstract readonly identifier: K
  abstract readonly identifierSchema: S["fields"][K]
  abstract readonly fields: ReadonlyArray<TableField>

  readonly createTable = Effect.fn("Table.createTable")(
    { self: this },
    function* (this: TableDefinition<Name, S, K>) {
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
export type AnyTableDefinition = TableDefinition<string, AnyStruct, string>

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
  K extends FieldName<S>,
> extends TableDefinition<Name, S, K> {
  constructor(
    readonly name: Name,
    readonly schema: S,
    readonly identifier: K,
    readonly identifierSchema: S["fields"][K],
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

    return new TableField(property.name, isString ? "string" : "number")
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
  const lengthIsOne = Equivalence.strictEqual<number>()
  const hasOneIdentifier = lengthIsOne(identifierFields.length, 1)

  if (!hasOneIdentifier) {
    return yield* new TableDefinitionError(
      name,
      "schema must contain exactly one Domain.identifier field",
    )
  }

  const identifierFieldOption = Array.get(identifierFields, 0)
  const identifierField = Option.getOrThrow(identifierFieldOption)

  const nullableIdentifierSchema =
    schema.fields[identifierField.name as FieldName<S>]

  const identifierSchemaOption = Option.fromNullishOr(nullableIdentifierSchema)

  const identifierSchema = Option.getOrThrow(identifierSchemaOption) as
    S["fields"][FieldName<S>]

  return new MadeTable(
    name,
    schema,
    identifierField.name as FieldName<S>,
    identifierSchema,
    fields,
  )
})

/**

Use when: defining persistence because a canonical struct can mechanically
compile to one table definition.

Example: `Table.make(BookSchema, { name: "books" })` derives a table.

**/
export abstract class Table {
  static make<
    const Name extends string,
    const S extends AnyStruct,
  >(
    schema: S & (IdentifierFieldName<S> extends never ? never : unknown),
    config: Readonly<{ name: Name }>,
  ): TableDefinition<Name, S, IdentifierFieldName<S>> {
    const compiled = compile(schema, config.name)

    return Effect.runSync(compiled) as unknown as TableDefinition<
      Name,
      S,
      IdentifierFieldName<S>
    >
  }
}
