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

export class TableError extends Schema.TaggedError<TableError>()(
  "TableError",
  {
    operation: Schema.Literal("createTable"),
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

export class TableField {
  constructor(
    readonly name: string,
    readonly scalar: "string" | "number",
  ) {}
}

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

export type AnyTableDefinition = TableDefinition<string, AnyStruct, string>

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
  const encoded = Schema.toEncoded(schema).ast

  if (!SchemaAST.isObjects(encoded) || encoded.indexSignatures.length > 0) {
    return yield* new TableDefinitionError(
      name,
      "schema must encode to a flat struct",
    )
  }

  const compileField = Effect.fn("Table.compileField")(function* (
    property: (typeof encoded.propertySignatures)[number],
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

    if (!isString && !isNumber) {
      return yield* new TableDefinitionError(
        name,
        `field ${property.name} must encode to String or Number`,
      )
    }

    return new TableField(property.name, isString ? "string" : "number")
  })

  const fields = yield* Effect.forEach(
    encoded.propertySignatures,
    compileField,
  )

  const hasIdentifierAnnotation = (field: TableField): boolean => {
    const fieldSchema = Option.getOrThrow(
      Option.fromNullishOr(schema.fields[field.name]),
    )
    const annotations = Option.fromNullishOr(
      Schema.resolveAnnotations(fieldSchema),
    )
    const annotation = Option.map(annotations, Struct.get(DomainIdentifier))
    return Option.containsWith(Equivalence.strictEqual<unknown>())(
      annotation,
      true,
    )
  }

  const identifierFields = Array.filter(fields, hasIdentifierAnnotation)

  if (identifierFields.length !== 1) {
    return yield* new TableDefinitionError(
      name,
      "schema must contain exactly one Domain.identifier field",
    )
  }

  const identifier = Option.getOrThrow(
    Array.get(identifierFields, 0),
  ).name as FieldName<S>
  const identifierSchema = Option.getOrThrow(
    Option.fromNullishOr(schema.fields[identifier]),
  )

  return new MadeTable(
    name,
    schema,
    identifier,
    identifierSchema,
    fields,
  )
})

export abstract class Table {
  static make<
    const Name extends string,
    const S extends AnyStruct,
  >(
    schema: S & (IdentifierFieldName<S> extends never ? never : unknown),
    config: Readonly<{ name: Name }>,
  ): TableDefinition<Name, S, IdentifierFieldName<S>> {
    return Effect.runSync(compile(schema, config.name)) as unknown as TableDefinition<
      Name,
      S,
      IdentifierFieldName<S>
    >
  }
}
