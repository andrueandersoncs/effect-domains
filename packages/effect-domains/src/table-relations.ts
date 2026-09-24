import { Array, Effect, Equivalence, flow, Function, HashMap, HashSet, Option, Record, Schema, String, Struct, pipe } from "effect"
import type { StructSchema, StructValue } from "./domain.ts"

import type { TableCheck } from "./table-check-model.ts"
import { TableField } from "./physical-table-field.ts"

import {
  TableForeignKey,
  TableForeignKeyReference,
  TableIndex,
  TableRelations,
  TableUnique,
} from "./physical-table-relations.ts"

import { isNumericTableScalar } from "./physical-table-scalar.ts"
import type { TableReference, TableRelationsInput } from "./table-relation-input.ts"

import { TableSnapshot } from "./table-snapshot-model.ts"

import { TableDefinitionError } from "./physical-table-definition-error.ts"

import {
  compileTable,
  type IdentifierName,
  type IdentifierSchema,
  type RowSchema,
  type TableColumn,
} from "./table-compiler.ts"


// SAFETY: The target intersects the source rather than discarding it because callers retain all source evidence and state each narrowing invariant.
const narrowContract = <Target, Source>(value: Source) => value as Source & Target

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

type RelationConstraint = TableUnique | TableForeignKey | TableIndex


const validateConstraintFields = Effect.fn("Table.validateConstraintFields")(function* (
  table: string,
  name: string,
  fields: ReadonlyArray<string>,
  available: HashSet.HashSet<string>,
) {
  const trimmedName = name.trim()
  const emptyName = Equivalence.strictEqual<number>()(trimmedName.length, 0)
  const emptyFields = Array.isReadonlyArrayEmpty(fields)

  if (emptyName) return yield* TableDefinitionError.make({ table: table, reason: "relation constraint name must not be empty" })
  if (emptyFields) return yield* TableDefinitionError.make({ table: table, reason: `relation constraint ${name} must declare fields` })

  return yield* Effect.reduce(
    fields,
    HashSet.empty<string>,
    Effect.fn("Table.validateConstraintField")(function* (seen, field) {
      const known = HashSet.has(available, field)
      const duplicate = HashSet.has(seen, field)

      if (!known) return yield* TableDefinitionError.make({ table: table, reason: `relation constraint ${name} declares unknown field ${field}` })
      if (duplicate) return yield* TableDefinitionError.make({ table: table, reason: `relation constraint ${name} declares duplicate field ${field}` })

      return HashSet.add(seen, field)
    }),
  )
})

const validateConstraint = (table: string, available: HashSet.HashSet<string>) =>
  Effect.fn("Table.validateConstraint")(function* (names: HashSet.HashSet<string>, constraint: RelationConstraint) {
    const duplicate = HashSet.has(names, constraint.name)

    if (duplicate) return yield* TableDefinitionError.make({ table: table, reason: `duplicate relation constraint name ${constraint.name}` })

    yield* validateConstraintFields(table, constraint.name, constraint.fields, available)

    return HashSet.add(names, constraint.name)
  })

const validateForeignKeyReference = (table: string) =>
  Effect.fn("Table.validateForeignKeyReference")(function* (foreignKey: TableForeignKey) {
    const referencedTable = foreignKey.references.table.trim()
    const emptyTable = Equivalence.strictEqual<number>()(referencedTable.length, 0)

    if (emptyTable) {
      return yield* TableDefinitionError.make({ table: table, reason: `foreign key constraint ${foreignKey.name} references an empty table` })
    }

    const referenceNames = HashSet.fromIterable(foreignKey.references.fields)

    yield* validateConstraintFields(table, foreignKey.name, foreignKey.references.fields, referenceNames)
  })


const validateReservedIndex = (table: string) =>
  Effect.fn("Table.validateReservedIndex")(function* (index: TableIndex) {
    const reservedPrefix = index.name.toLowerCase().startsWith("sqlite_")

    if (reservedPrefix) {
      return yield* TableDefinitionError.make({ table: table, reason: `index constraint ${index.name} uses the reserved sqlite_ prefix` })
    }
  })

const validateLocalRelations = Effect.fn("Table.validateLocalRelations")(function* (
  table: string,
  fields: ReadonlyArray<TableField>,
  relations: Option.Option<TableRelations>,
) {
  if (Option.isNone(relations)) return

  const fieldNames = Array.map(fields, Struct.get("name"))
  const available = HashSet.fromIterable(fieldNames)
  const unique = relations.value.unique ?? []
  const foreignKeys = relations.value.foreignKeys ?? []
  const indexes = relations.value.indexes ?? []
  const localConstraints = Array.appendAll(unique, foreignKeys)
  const constraints: ReadonlyArray<RelationConstraint> = Array.appendAll(localConstraints, indexes)

  yield* Effect.reduce(constraints, HashSet.empty<string>, validateConstraint(table, available))
  yield* Effect.forEach(relations.value.foreignKeys ?? [], validateForeignKeyReference(table))
  yield* Effect.forEach(relations.value.indexes ?? [], validateReservedIndex(table))
})


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


const tablesEqual = Equivalence.strictEqual<Table>()

const make = <const Name extends string, const S extends StructSchema>(
  options: Readonly<{ name: Name; schema: S }> & Readonly<Partial<{ relations: TableRelationsInput<TableFieldName<S>> }>>,
): Table<Name, RowSchema<S>, InsertSchema<S>, StoredRowSchema<RowSchema<S>>, [IdentifierName<S>] extends [never] ? "id" : IdentifierName<S>, IdentifierSchema<S>, IdentifierStorageSchema<IdentifierSchema<S>>, TableColumns<RowSchema<S>["fields"]>> => {
  const compilation = compileTable(options.name, options.schema)
  const result = Effect.runSync(compilation)
  const relations = Option.fromNullishOr(options.relations)
  const noRelationTargets: ReadonlyArray<Table> = Array.empty()
  const withoutRelationTargets = Function.constant(noRelationTargets)

  const relationTargets: ReadonlyArray<Table> = Option.match(relations, {
    onNone: withoutRelationTargets,
    onSome: (value) => pipe(
      value.foreignKeys ?? [],
      Array.map((foreignKey) => foreignKey.references.table),
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

  const resultWithTargets = Struct.assign(result, { relationTargets })
  const base = narrowContract<Result, typeof resultWithTargets>(resultWithTargets)

  return Option.match(copiedRelations, {
    onNone: Function.constant(base),
    onSome: (relations) => Struct.assign(base, { relations }),
  })
}

// Branch before construction because Schema.Class rejects an explicitly undefined optional field.
const snapshotInput = (table: Table) => {
  const relations = Option.fromNullishOr(table.relations)

  return Option.match(relations, {
    onNone: () => TableSnapshot.make({
      name: table.name,
      identifier: table.identifier,
      fields: table.fields,
    }),
    onSome: (value) => TableSnapshot.make({
      name: table.name,
      identifier: table.identifier,
      fields: table.fields,
      relations: value,
    }),
  })
}

const snapshot = flow(
  snapshotInput,
  Schema.decodeUnknownEffect(TableSnapshot),
  Effect.runSync,
)

const fieldsEqual = Equivalence.Array(Equivalence.strictEqual<string>())


const compatibleForeignKeyScalars = (source: TableField["scalar"], target: TableField["scalar"]) => {
  const same = Equivalence.strictEqual<TableField["scalar"]>()(source, target)
  const numeric = isNumericTableScalar(source) && isNumericTableScalar(target)

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

  if (duplicate) return yield* TableDefinitionError.make({ table: table.name, reason: `duplicate table ${table.name}` })

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

    if (tableCollision) return yield* TableDefinitionError.make({ table: table, reason: `index constraint ${index.name} collides with a table name` })
    if (duplicate) return yield* TableDefinitionError.make({ table: table, reason: `duplicate index constraint name ${index.name}` })

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
    return yield* TableDefinitionError.make({ table: table.name, reason: `foreign key constraint ${foreignKey.name} references unknown field ${sourceName} or ${targetName}` })
  }

  const [sourceField, referencedField] = fields.value
  const compatible = compatibleForeignKeyScalars(sourceField.scalar, referencedField.scalar)

  if (!compatible) {
    return yield* TableDefinitionError.make({ table: table.name, reason: `foreign key constraint ${foreignKey.name} has incompatible field types ${sourceName} and ${target.name}.${targetName}` })
  }
}

const validateForeignKey = (
  tables: HashMap.HashMap<string, TableSnapshot>,
  table: TableSnapshot,
) => Effect.fn("Table.validateForeignKey")(function* (foreignKey: TableForeignKey) {
  const targetOption = HashMap.get(tables, foreignKey.references.table)

  if (Option.isNone(targetOption)) {
    return yield* TableDefinitionError.make({ table: table.name, reason: `foreign key constraint ${foreignKey.name} references unknown table ${foreignKey.references.table}` })
  }

  const arityMatches = Equivalence.strictEqual<number>()(
    foreignKey.fields.length,
    foreignKey.references.fields.length,
  )

  if (!arityMatches) {
    return yield* TableDefinitionError.make({ table: table.name, reason: `foreign key constraint ${foreignKey.name} has incompatible source and target arity` })
  }

  const referencedTable = Option.getOrThrow(targetOption)
  const targetIsIdentifier = fieldsEqual(foreignKey.references.fields, [referencedTable.identifier])
  const unique = referencedTable.relations?.unique ?? []
  const targetIsUnique = Array.some(unique, uniqueFieldsEqual(foreignKey.references.fields))
  const validTarget = targetIsIdentifier || targetIsUnique

  if (!validTarget) {
    return yield* TableDefinitionError.make({ table: table.name, reason: `foreign key constraint ${foreignKey.name} must reference the primary key or a declared unique tuple of ${referencedTable.name}` })
  }

  const sourceEntries = Array.map(table.fields, fieldEntry)
  const targetEntries = Array.map(referencedTable.fields, fieldEntry)
  const sourceFields = HashMap.fromIterable(sourceEntries)
  const targetFields = HashMap.fromIterable(targetEntries)
  const pairs = Array.zip(foreignKey.fields, foreignKey.references.fields)

  const validatePair = Effect.fn("Table.validateForeignKeyPair")(function* (pair: readonly [string, string]) {
    yield* validateForeignKeyPair(
      table,
      foreignKey,
      sourceFields,
      referencedTable,
      targetFields,
    )(pair)
  })

  yield* Effect.forEach(pairs, validatePair)
})

const validateForeignKeys = (tables: HashMap.HashMap<string, TableSnapshot>) => (table: TableSnapshot) =>
  Effect.forEach(table.relations?.foreignKeys ?? [], validateForeignKey(tables, table))

const validateRelations = Effect.fn("Table.validateRelations")(function* (
  tables: ReadonlyArray<TableSnapshot>,
) {
  const tableEntries = Array.map(tables, tableEntry)
  const byName = HashMap.fromIterable(tableEntries)
  const emptyTableNames = Function.constant(emptyNames)
  const tableNames = yield* Effect.reduce(tables, emptyTableNames, validateTable)
  const indexes = Array.flatMap(tables, tableIndexPairs)

  yield* Effect.reduce(indexes, emptyTableNames, validateIndex(tableNames))
  yield* Effect.forEach(tables, validateForeignKeys(byName))
})

export { make, snapshot, validateRelations }
