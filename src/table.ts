import {
  Array,
  Brand,
  Context,
  Effect,
  Equivalence,
  Match,
  Option,
  pipe,
  Predicate,
  Record,
  Schema,
  SchemaAST,
  Struct,
} from "effect"
import { DomainIdentifier } from "./domain.ts"
import {
  evaluate,
  type SchemaASTF,
  type SchemaASTFAlgebra,
} from "./schema-ast.ts"

export const DefaultTableIdentifierSchema = Schema.String.check(Schema.isUUID(7))

const CreateTableOperationSchema = Schema.Literal("createTable")

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


const unsupportedTableScalar = (table: string, field: string) =>
  Effect.fail(
    new TableDefinitionError(
      table,
      `field ${field} must encode to String or Number`,
    ),
  )

const commonTableScalar = (
  table: string,
  field: string,
  scalars: ReadonlyArray<TableField["scalar"]>,
): Effect.Effect<TableField["scalar"], TableDefinitionError> => {
  const firstScalar = Array.get(scalars, 0)

  if (Option.isNone(firstScalar)) {
    return unsupportedTableScalar(table, field)
  }

  const scalarEqualsFirst = (scalar: TableField["scalar"]) =>
    Equivalence.strictEqual<TableField["scalar"]>()(firstScalar.value, scalar)

  const hasCommonScalar = Array.every(scalars, scalarEqualsFirst)

  return hasCommonScalar
    ? Effect.succeed(firstScalar.value)
    : unsupportedTableScalar(table, field)
}

const classifyEnumEntry = (
  [, value]: SchemaAST.Enum["enums"][number],
) => Predicate.isString(value) ? "string" as const : "number" as const

const evaluateTableScalar = Effect.fn("Table.evaluateScalar")(function* (
  table: string,
  field: string,
  ast: SchemaAST.AST,
) {
  const unsupported = (): Effect.Effect<
    TableField["scalar"],
    TableDefinitionError
  > => unsupportedTableScalar(table, field)

  const evaluateEnumeration = (
    enumeration: Extract<
      SchemaASTF<ReturnType<typeof unsupported>>,
      { readonly _tag: "Enum" }
    >,
  ) =>
    commonTableScalar(
      table,
      field,
      Array.map(enumeration.ast.enums, classifyEnumEntry),
    )

  const selectCommonScalar = (
    scalars: ReadonlyArray<TableField["scalar"]>,
  ) => commonTableScalar(table, field, scalars)

  const algebra: SchemaASTFAlgebra<ReturnType<typeof unsupported>> = pipe(
    Match.type<SchemaASTF<ReturnType<typeof unsupported>>>(),
    Match.tagsExhaustive({
      Declaration: unsupported,
      Null: unsupported,
      Undefined: unsupported,
      Void: unsupported,
      Never: unsupported,
      Unknown: unsupported,
      Any: unsupported,
      String: () => Effect.succeed<TableField["scalar"]>("string"),
      Number: () => Effect.succeed<TableField["scalar"]>("number"),
      Boolean: unsupported,
      BigInt: unsupported,
      Symbol: unsupported,
      Literal: (literal) => {
        if (Predicate.isString(literal.ast.literal)) {
          return Effect.succeed<TableField["scalar"]>("string")
        }

        return Predicate.isNumber(literal.ast.literal)
          ? Effect.succeed<TableField["scalar"]>("number")
          : unsupported()
      },
      UniqueSymbol: unsupported,
      ObjectKeyword: unsupported,
      Enum: evaluateEnumeration,
      TemplateLiteral: () =>
        Effect.succeed<TableField["scalar"]>("string"),
      Arrays: unsupported,
      Objects: unsupported,
      Union: (union) =>
        pipe(
          Effect.all(union.types),
          Effect.flatMap(selectCommonScalar),
        ),
      Suspend: (suspend) => suspend.thunk(),
    }),
  )

  return yield* evaluate(ast, algebra, unsupported)
})

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

      const scalar = yield* evaluateTableScalar(
        name,
        property.name,
        property.type,
      )

      return TableField.make({
        name: property.name,
        scalar,
        generation: NoGeneration,
      })
    })

    const fields = yield* Effect.forEach(
      encodedSchema.ast.propertySignatures,
      compileField,
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
