import {
  Array,
  Brand,
  Context,
  Effect,
  Equivalence,
  Option,
  pipe,
  Predicate,
  Record,
  Schema,
  SchemaAST,
  Struct,
} from "effect"
import { DomainIdentifier } from "./domain.ts"

/**
 *
 * Scope: public
 *
 * When to use: An operation must accept generated identity because a table
 * without domain identity receives a physical UUIDv7 field.
 *
 * Example:
 * ```ts
 * import { Schema } from "effect"
 * import { DefaultTableIdentifierSchema } from "effect-domains/table"
 *
 * const decodeIdentifier = Schema.decodeUnknownEffect(DefaultTableIdentifierSchema)
 * ```
 *
 */
export const DefaultTableIdentifierSchema = Schema.String.check(Schema.isUUID(7))

const CreateTableOperationSchema = Schema.Literal("createTable")

/**
 *
 * Scope: public
 *
 * When to use: Adapter metadata needs a validated physical field because table
 * rendering accepts only supported scalar columns.
 *
 * Example:
 * ```ts
 * import { Option } from "effect"
 * import { TableField } from "effect-domains/table"
 *
 * const title = TableField.make({ name: "title", scalar: "string", generation: Option.none() })
 * ```
 *
 */
export class TableField extends Schema.TaggedClass<TableField>()("TableField", {
  name: Schema.String,
  scalar: Schema.Literals(["string", "number"]),
  generation: Schema.Option(Schema.Literal("uuidv7")),
}) {}

const DefaultIdentifierFields = Record.singleton(
  "id",
  DefaultTableIdentifierSchema,
)

const NoGeneration = Option.none<"uuidv7">()
const GeneratedIdentifierGeneration = Option.some<"uuidv7">("uuidv7")

const DefaultIdentifierField = TableField.make({
  name: "id",
  scalar: "string",
  generation: GeneratedIdentifierGeneration,
})

/**
 *
 * Scope: public
 *
 * When to use: Table metadata validation must report why a canonical schema
 * cannot produce a physical table because invalid derivation must stop before
 * database work.
 *
 * Example:
 * ```ts
 * import { TableDefinitionError } from "effect-domains/table"
 *
 * const error = new TableDefinitionError("books", "schema must encode to a flat struct")
 * ```
 *
 */
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

/**
 *
 * Scope: public
 *
 * When to use: A table adapter must preserve a failed physical table-creation
 * operation in its Effect error channel because callers need the original
 * database cause.
 *
 * Example:
 * ```ts
 * import { TableError } from "effect-domains/table"
 *
 * const error = new TableError("books", new Error("database unavailable"))
 * ```
 *
 */
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
 *
 * Scope: public
 *
 * When to use: A runtime adapter must implement physical table creation for
 * compiled table definitions because effects require a narrow runtime boundary.
 *
 * Example:
 * ```ts
 * import { Effect } from "effect"
 * import { TableStore } from "effect-domains/table"
 *
 * const store = TableStore.of({ write: () => Effect.void })
 * ```
 *
 */
export class TableStore extends Context.Service<TableStore, {
  readonly write: (
    table: Table,
  ) => Effect.Effect<void, TableError>
}>()("@effect-domains/TableStore") {}

type IdentifierName<S extends Schema.Struct<Schema.Struct.Fields>> = {
  [K in Extract<keyof S["fields"], string>]: S["fields"][K]["Type"] extends Brand.Brand<
    typeof DomainIdentifier
  > ? K
    : never
}[Extract<keyof S["fields"], string>]

type RowSchema<S extends Schema.Struct<Schema.Struct.Fields>> = [IdentifierName<S>] extends [never]
  ? Schema.Struct<Readonly<typeof DefaultIdentifierFields> & S["fields"]>
  : S

type IdentifierSchema<S extends Schema.Struct<Schema.Struct.Fields>> =
  [IdentifierName<S>] extends [never]
    ? typeof DefaultIdentifierFields.id
    : S["fields"][IdentifierName<S>]

const compileTable = Effect.fn("Table.compile")(function* <
  const Name extends string,
  const S extends Schema.Struct<Schema.Struct.Fields>,
>(name: Name, schema: S) {
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
        "schema must not contain index signatures",
      )
    }

    const compileName = Effect.fn("Table.compileName")(function* (
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
      const isUnsupportedScalar = !isSupportedScalar

      if (isUnsupportedScalar) {
        return yield* new TableDefinitionError(
          name,
          `field ${property.name} must encode to String or Number`,
        )
      }

      return TableField.make({
        name: property.name,
        scalar: isString ? "string" : "number",
        generation: NoGeneration,
      })
    })

    const fields = yield* Effect.forEach(
      encodedSchema.ast.propertySignatures,
      compileName,
    )

    const hasIdentifierAnnotation = (field: TableField): boolean => {
      const fieldSchema = Option.getOrThrow(
        Option.fromNullishOr(schema.fields[field.name]),
      )

      return Option.containsWith(Equivalence.strictEqual<unknown>())(
        Option.map(
          Option.fromNullishOr(Schema.resolveAnnotations(fieldSchema)),
          Struct.get(DomainIdentifier),
        ),
        true,
      )
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

      const identifierSchema = Option.getOrThrow(
        Option.fromNullishOr(
          schema.fields[
            identifierField.name as Extract<keyof S["fields"], string>
          ],
        ),
      )

      return {
        name,
        schema,
        rowSchema: schema,
        identifier: identifierField.name,
        identifierSchema,
        fields,
      }
    }

    const fieldIsReserved = (field: TableField) =>
      Equivalence.strictEqual<string>()(field.name, "id")

    const idIsReserved = Array.some(fields, fieldIsReserved)

    if (idIsReserved) {
      return yield* new TableDefinitionError(
        name,
        "field id must use Domain.identifier when overriding the default UUIDv7 identifier",
      )
    }

    const rowSchema = pipe(
      schema,
      Schema.fieldsAssign(DefaultIdentifierFields),
    )

    return {
      name,
      schema,
      rowSchema,
      identifier: "id" as const,
      identifierSchema: rowSchema.fields.id,
      fields: [DefaultIdentifierField, ...fields],
    }
  })

/**
 *
 * Scope: public
 *
 * When to use: A canonical struct needs table metadata because persistence
 * mappings may only be mechanical and lossless.
 *
 * Example:
 * ```ts
 * import { Schema } from "effect"
 * import { Table } from "effect-domains/table"
 *
 * const Books = Table.make({ name: "books", schema: Schema.Struct({ title: Schema.String }) })
 * ```
 *
 */
export class Table extends Schema.Class<Table>("Table")({
  name: Schema.String,
  schema: Schema.Any,
  rowSchema: Schema.Any,
  identifier: Schema.String,
  identifierSchema: Schema.Any,
  fields: Schema.Array(TableField),
}) {
  static override make<
    const Name extends string,
    const S extends Schema.Struct<Schema.Struct.Fields>,
  >(
    options: Readonly<{
      name: Name
      schema: S
    }>,
  ): TableDefinition<
    Name,
    S,
    [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>,
    RowSchema<S>,
    IdentifierSchema<S>
  > {
    const compiled = Effect.runSync(compileTable(options.name, options.schema))

    const base = super.make({
      name: compiled.name,
      schema: compiled.schema,
      rowSchema: compiled.rowSchema,
      identifier: compiled.identifier,
      identifierSchema: compiled.identifierSchema,
      fields: compiled.fields,
    })

    const table = Struct.assign(base, {
      write: Effect.fn("Table.write")(function* () {
        const store = yield* TableStore

        return yield* store.write(table)
      }),
    }) as TableDefinition<
      Name,
      S,
      [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>,
      RowSchema<S>,
      IdentifierSchema<S>
    >

    return table
  }
}

interface TableDefinition<
  Name extends string,
  S extends Schema.Struct<Schema.Struct.Fields>,
  K extends string,
  Row extends Schema.Struct<Schema.Struct.Fields>,
  IdentifierSchema extends Schema.Constraint,
> extends Schema.Schema.Type<typeof Table> {
  readonly name: Name
  readonly schema: S
  readonly rowSchema: Row
  readonly identifier: K
  readonly identifierSchema: IdentifierSchema
  readonly write: () => Effect.Effect<void, TableError, TableStore>
}
