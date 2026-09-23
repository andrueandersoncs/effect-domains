import { Array, Effect, Equivalence, Function, HashMap, HashSet, Option, Record, Schema, String, Struct, pipe } from "effect"
import type { StructSchema, StructValue } from "./domain.ts"

import {
  failTableDefinition,
  isOneOfCheck,
  numericScalar,
  type TableCheck,
  TableField,
  TableForeignKey,
  TableForeignKeyReference,
  TableIndex,
  TableRelations,
  type TableRelationsInput,
  type TableReference,
  TableSnapshot,
  TableUnique,
  validateLocalRelations,
} from "./table-model.ts"

import {
  compileTable,
  type IdentifierName,
  type IdentifierSchema,
  type RowSchema,
  type TableColumn,
} from "./table-compiler.ts"

type TableColumns<Fields extends Schema.Struct.Fields> = Readonly<{
  [K in Extract<keyof Fields, string>]: TableColumn
}>

type InsertSchema<S extends StructSchema> = Schema.Codec<S["Type"], StructValue, S["DecodingServices"], S["EncodingServices"]>
type StoredRowSchema<Row extends StructSchema> = Schema.Codec<Row["Type"], StructValue, Row["DecodingServices"], Row["EncodingServices"]>
type IdentifierStorageSchema<Identifier extends Schema.Constraint> = Schema.Codec<Identifier["Type"], unknown, Identifier["DecodingServices"], Identifier["EncodingServices"]>

export interface Table<
  Name extends string = string,
  Row extends StructSchema = StructSchema,
  Insert extends Schema.Constraint = Schema.Codec<unknown, unknown, unknown, unknown>,
  Storage extends Schema.Constraint = Schema.Codec<unknown, unknown, unknown, unknown>,
  Key extends string = string,
  Identifier extends Schema.Constraint = Schema.Constraint,
  IdentifierStorage extends Schema.Constraint = Schema.Constraint,
  Columns extends Readonly<Record<string, TableColumn>> = Readonly<Record<string, TableColumn>>,
> extends Readonly<Partial<{ relations: TableRelations }>> {
  readonly _tag: "Table"
  readonly name: Name
  readonly schema: StructSchema
  readonly rowSchema: Row
  readonly insertSchema: Insert
  readonly storageSchema: Storage
  readonly identifier: Key
  readonly identifierSchema: Identifier
  readonly identifierStorageSchema: IdentifierStorage
  readonly fields: ReadonlyArray<TableField>
  readonly columns: Columns
  readonly relationTargets: ReadonlyArray<Table>
}

export type TableFieldName<S extends StructSchema> = Extract<keyof RowSchema<S>["fields"], string>

// Derive snake_case names because the hand-written histories already follow SQL convention.
const constraintName = (table: string, fields: ReadonlyArray<string>, suffix: string) => {
  const segments = Array.map(fields, String.camelToSnake)
  const joined = Array.join(segments, "_")

  return `${table}_${joined}_${suffix}`
}

const cloneRelations = <Fields extends string>(table: string, relations: TableRelationsInput<Fields>) => {
  const unique = pipe(
    Option.fromNullishOr(relations.unique),
    Option.map(Array.map((constraint) => {
      const name = pipe(
        Option.fromNullishOr(constraint.name),
        Option.getOrElse(() => constraintName(table, constraint.fields, "key")),
      )

      return TableUnique.make({ name, fields: constraint.fields })
    })),
  )

  const foreignKeys = pipe(
    Option.fromNullishOr(relations.foreignKeys),
    Option.map(Array.map((constraint) => {
      const scope = pipe(Option.fromNullishOr(constraint.scope), Option.getOrElse(Array.empty))
      const fields = Array.appendAll(scope, constraint.fields)
      const referenced = Array.appendAll(scope, constraint.references.fields)

      const name = pipe(
        Option.fromNullishOr(constraint.name),
        Option.getOrElse(() => constraintName(table, fields, "fkey")),
      )

      const references = TableForeignKeyReference.make({ table: constraint.references.table.name, fields: referenced })

      return TableForeignKey.make({ name, fields, references })
    })),
  )

  const indexes = pipe(
    Option.fromNullishOr(relations.indexes),
    Option.map(Array.map((constraint) => {
      const name = pipe(
        Option.fromNullishOr(constraint.name),
        Option.getOrElse(() => constraintName(table, constraint.fields, "idx")),
      )

      return TableIndex.make({ name, fields: constraint.fields })
    })),
  )

  return TableRelations.make(Record.getSomes({ unique, foreignKeys, indexes }))
}

const foreignKeyTarget = (foreignKey: { readonly references: TableReference }) => foreignKey.references.table

const tablesEqual = Equivalence.strictEqual<Table>()

const make = <const Name extends string, const S extends StructSchema>(
  options: Readonly<{ name: Name; schema: S }> & Readonly<Partial<{ relations: TableRelationsInput<TableFieldName<S>> }>>,
): Table<Name, RowSchema<S>, InsertSchema<S>, StoredRowSchema<RowSchema<S>>, [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>, IdentifierSchema<S>, IdentifierStorageSchema<IdentifierSchema<S>>, TableColumns<RowSchema<S>["fields"]>> => {
  const result = Effect.runSync(compileTable(options.name, options.schema))
  const relations = Option.fromNullishOr(options.relations)

  const relationTargets: ReadonlyArray<Table> = Option.match(relations, {
    onNone: Array.empty,
    onSome: (value) => pipe(
      value.foreignKeys ?? [],
      Array.map(foreignKeyTarget),
      Array.dedupeWith(tablesEqual),
    ),
  })

  const copiedRelations = pipe(relations, Option.map((value) => cloneRelations(result.name, value)))

  const validation = pipe(copiedRelations, Option.match({
    onNone: Function.constant(Effect.void),
    onSome: (value) => {
      const localRelations = Option.some(value)

      return validateLocalRelations(result.name, result.fields, localRelations)
    },
  }))

  Effect.runSync(validation)

  type Result = Table<Name, RowSchema<S>, InsertSchema<S>, StoredRowSchema<RowSchema<S>>, [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>, IdentifierSchema<S>, IdentifierStorageSchema<IdentifierSchema<S>>, TableColumns<RowSchema<S>["fields"]>>

  // SAFETY: compileTable selects the conditional RowSchema branch from the same schema S; TypeScript cannot reduce that branch for a generic S.
  const base: Result = Object.assign({}, result, { relationTargets }) as unknown as Result

  return Option.match(copiedRelations, {
    onNone: () => base,
    onSome: (relations) => Object.assign({}, base, { relations }),
  })
}

// Decode the physical model because native Schema traversal copies nested arrays and classes.
const snapshot = (table: Table) => pipe(
  table,
  Struct.pick(["name", "identifier", "fields", "relations"]),
  Schema.decodeUnknownEffect(TableSnapshot),
  Effect.runSync,
)

const fieldsEqual = Equivalence.Array(Equivalence.strictEqual<string>())

const compatibleForeignKeyScalars = (source: TableField["scalar"], target: TableField["scalar"]) => {
  const same = Equivalence.strictEqual<TableField["scalar"]>()(source, target)
  const numeric = numericScalar(source) && numericScalar(target)

  return same || numeric
}

const tableEntry = (table: TableSnapshot) => [table.name, table] as const
const tableIndexPair = (table: TableSnapshot) => (index: TableIndex) => [table.name, index] as const

const tableIndexPairs = (table: TableSnapshot) =>
  Array.map(table.relations?.indexes ?? [], tableIndexPair(table))

const fieldEntry = (field: TableField) => [field.name, field] as const

const emptyNames = HashSet.empty<string>()

const validateTable = Effect.fn("Table.validateTable")(function* (
  names: HashSet.HashSet<string>,
  table: TableSnapshot,
) {
  const normalized = table.name.toLowerCase()
  const duplicate = HashSet.has(names, normalized)

  if (duplicate) return yield* failTableDefinition(table.name, `duplicate table ${table.name}`)

  const relations = Option.fromNullishOr(table.relations)

  yield* validateLocalRelations(table.name, table.fields, relations)

  return HashSet.add(names, normalized)
})

const validateIndex = (tableNames: HashSet.HashSet<string>) =>
  Effect.fn("Table.validateIndex")(function* (
    indexNames: HashSet.HashSet<string>,
    entry: readonly [string, TableIndex],
  ) {
    const [table, index] = entry
    const normalized = index.name.toLowerCase()
    const tableCollision = HashSet.has(tableNames, normalized)
    const duplicate = HashSet.has(indexNames, normalized)

    if (tableCollision) return yield* failTableDefinition(table, `index constraint ${index.name} collides with a table name`)
    if (duplicate) return yield* failTableDefinition(table, `duplicate index constraint name ${index.name}`)

    return HashSet.add(indexNames, normalized)
  })

const uniqueFieldsEqual = (fields: ReadonlyArray<string>) => (unique: TableUnique) =>
  fieldsEqual(unique.fields, fields)

const validateForeignKeyPair = (
  table: TableSnapshot,
  foreignKey: TableForeignKey,
  sourceFields: HashMap.HashMap<string, TableField>,
  target: TableSnapshot,
  targetFields: HashMap.HashMap<string, TableField>,
) => function* (
  [sourceName, targetName]: readonly [string, string],
) {
  const source = HashMap.get(sourceFields, sourceName)
  const targetField = HashMap.get(targetFields, targetName)
  const fields = Option.all([source, targetField])

  if (Option.isNone(fields)) {
    return yield* failTableDefinition(
      table.name,
      `foreign key constraint ${foreignKey.name} references unknown field ${sourceName} or ${targetName}`,
    )
  }

  const [sourceField, referencedField] = fields.value
  const compatible = compatibleForeignKeyScalars(sourceField.scalar, referencedField.scalar)

  if (!compatible) {
    return yield* failTableDefinition(
      table.name,
      `foreign key constraint ${foreignKey.name} has incompatible field types ${sourceName} and ${target.name}.${targetName}`,
    )
  }
}

const validateForeignKey = (
  tables: HashMap.HashMap<string, TableSnapshot>,
  table: TableSnapshot,
) => Effect.fn("Table.validateForeignKey")(function* (foreignKey: TableForeignKey) {
  const targetOption = HashMap.get(tables, foreignKey.references.table)

  if (Option.isNone(targetOption)) {
    return yield* failTableDefinition(
      table.name,
      `foreign key constraint ${foreignKey.name} references unknown table ${foreignKey.references.table}`,
    )
  }

  const arityMatches = Equivalence.strictEqual<number>()(
    foreignKey.fields.length,
    foreignKey.references.fields.length,
  )

  if (!arityMatches) {
    return yield* failTableDefinition(
      table.name,
      `foreign key constraint ${foreignKey.name} has incompatible source and target arity`,
    )
  }

  const target = targetOption.value
  const targetIsIdentifier = fieldsEqual(foreignKey.references.fields, [target.identifier])
  const unique = target.relations?.unique ?? []
  const targetIsUnique = Array.some(unique, uniqueFieldsEqual(foreignKey.references.fields))
  const validTarget = targetIsIdentifier || targetIsUnique

  if (!validTarget) {
    return yield* failTableDefinition(
      table.name,
      `foreign key constraint ${foreignKey.name} must reference the primary key or a declared unique tuple of ${target.name}`,
    )
  }

  const sourceEntries = Array.map(table.fields, fieldEntry)
  const targetEntries = Array.map(target.fields, fieldEntry)
  const sourceFields = HashMap.fromIterable(sourceEntries)
  const targetFields = HashMap.fromIterable(targetEntries)
  const pairs = Array.zip(foreignKey.fields, foreignKey.references.fields)

  yield* Effect.forEach(
    pairs,
    ([sourceName, targetName]) => Effect.gen(() => validateForeignKeyPair(
      table,
      foreignKey,
      sourceFields,
      target,
      targetFields,
    )([sourceName, targetName])),
  )
})

const validateForeignKeys = (tables: HashMap.HashMap<string, TableSnapshot>) => (table: TableSnapshot) =>
  Effect.forEach(table.relations?.foreignKeys ?? [], validateForeignKey(tables, table))

const validateRelations = Effect.fn("Table.validateRelations")(function* (
  tables: ReadonlyArray<TableSnapshot>,
) {
  const tableEntries = Array.map(tables, tableEntry)
  const byName = HashMap.fromIterable(tableEntries)
  const tableNames = yield* Effect.reduce(tables, () => emptyNames, validateTable)
  const indexes = Array.flatMap(tables, tableIndexPairs)

  yield* Effect.reduce(indexes, () => emptyNames, validateIndex(tableNames))
  yield* Effect.forEach(tables, validateForeignKeys(byName))
})

export { isOneOfCheck, make, snapshot, validateRelations }
