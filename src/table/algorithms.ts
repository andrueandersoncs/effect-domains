import {
  Array,
  Brand,
  Effect,
  Equivalence,
  flow,
  Function,
  Option,
  pipe,
  Predicate,
  Schema,
  SchemaAST,
  Struct,
} from "effect"
import { DomainIdentifier } from "../domain/constants.ts"
import {
  DefaultIdentifierField,
  DefaultIdentifierFields,
  NoGeneration,
} from "./constants.ts"
import { TableDefinitionError, type TableError } from "./errors.ts"
import { TableStore } from "./services.ts"
import type { TableDefinition } from "./types.ts"
import { TableFieldSchema, type TableField } from "./schemas.ts"

/**
 *
 * Scope: public
 *
 * When to use: A canonical struct must derive table metadata because
 * persistence mappings may only be mechanical and lossless.
 *
 * Example:
 * ```ts
 * import { Schema } from "effect"
 * import { tableName } from "./algorithms.ts"
 *
 * const Books = tableName("books", Schema.Struct({ title: Schema.String }))
 * ```
 *
 */
export const tableName = <
  const Name extends string,
  const S extends Schema.Struct<Schema.Struct.Fields>,
>(name: Name, schema: S) => {
    type IdentifierName = {
      [K in Extract<keyof S["fields"], string>]: S["fields"][K]["Type"] extends Brand.Brand<
        typeof DomainIdentifier
      > ? K
        : never
    }[Extract<keyof S["fields"], string>]

    type RowFields = [IdentifierName] extends [never]
      ? Readonly<typeof DefaultIdentifierFields> & S["fields"]
      : S["fields"]

    type RowSchema = [IdentifierName] extends [never]
      ? Schema.Struct<RowFields>
      : S

    type IdentifierSchema = [IdentifierName] extends [never]
      ? typeof DefaultIdentifierFields.id
      : S["fields"][IdentifierName]

    const compile = Effect.gen(function* () {
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

        return TableFieldSchema.make({
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
        const nullableFieldSchema = schema.fields[field.name]
        const fieldSchemaOption = Option.fromNullishOr(nullableFieldSchema)
        const fieldSchema = Option.getOrThrow(fieldSchemaOption)
        const resolvedAnnotations = Schema.resolveAnnotations(fieldSchema)
        const annotations = Option.fromNullishOr(resolvedAnnotations)

        const annotation = Option.map(
          annotations,
          Struct.get(DomainIdentifier),
        )

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
          schema.fields[
            identifierField.name as Extract<keyof S["fields"], string>
          ]

        const identifierSchemaOption = Option.fromNullishOr(
          nullableIdentifierSchema,
        )

        const identifierSchema = Option.getOrThrow(identifierSchemaOption)

        const write: () => Effect.Effect<
          void,
          TableError,
          TableStore
        > = Effect.fn("Table.write")(function* () {
          const store = yield* TableStore

          return yield* store.write(definition)
        })

        const definition: TableDefinition<
          Name,
          S,
          string,
          S,
          Schema.Constraint
        > = Function.identity({
          name,
          schema,
          rowSchema: schema,
          identifier: identifierField.name,
          identifierSchema,
          fields,
          write,
        })

        return definition
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

      const rowSchema = pipe(
        schema,
        Schema.fieldsAssign(DefaultIdentifierFields),
      )

      const tableFields = [DefaultIdentifierField, ...fields]

      const write: () => Effect.Effect<
        void,
        TableError,
        TableStore
      > = Effect.fn("Table.write")(function* () {
        const store = yield* TableStore

        return yield* store.write(definition)
      })

      const definition: TableDefinition<
        Name,
        S,
        "id",
        typeof rowSchema,
        typeof rowSchema.fields.id
      > = Function.identity({
        name,
        schema,
        rowSchema,
        identifier: "id" as const,
        identifierSchema: rowSchema.fields.id,
        fields: tableFields,
        write,
      })

      return definition
    })

    const compiled = Effect.runSync(compile)

    return (compiled as TableDefinition<
      Name,
      S,
      string,
      Schema.Struct<Schema.Struct.Fields>,
      Schema.Constraint
    >) as TableDefinition<
      Name,
      S,
      [IdentifierName] extends [never] ? "id" : IdentifierName,
      RowSchema,
      IdentifierSchema
    >
  }
