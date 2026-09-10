import { Array, Equivalence, Function, Match, Option, Predicate, Schema, pipe } from "effect"
import type { TableCheck, TableField, TableForeignKey, TableIndex, TableSnapshot, TableUnique } from "./table.ts"

export const quoteIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`

const quoteLiteral = (value: string | number) => {
  if (Predicate.isString(value)) return `'${value.replaceAll("'", "''")}'`

  const finite = Schema.Finite.make(value)
  return String(finite)
}

const typeFor = (scalar: TableField["scalar"]) => pipe(
  Match.value(scalar),
  Match.when("string", Function.constant("TEXT")),
  Match.when("integer", Function.constant("INTEGER")),
  Match.orElse(Function.constant("REAL")),
)

const acceptsFor = (scalar: TableField["scalar"]) => pipe(
  Match.value(scalar),
  Match.when("string", Function.constant("= 'text'")),
  Match.when("integer", Function.constant("= 'integer'")),
  Match.orElse(Function.constant("IN ('integer', 'real')")),
)

const typeCheck = (field: TableField) => {
  const column = quoteIdentifier(field.name)
  const accepted = acceptsFor(field.scalar)
  const expression = `typeof(${column}) ${accepted}`
  return field.nullable ? `CHECK (${column} IS NULL OR ${expression})` : `CHECK (${expression})`
}

const comparisonCheck = (operator: string) => (field: TableField) => (value: number) => {
  const column = quoteIdentifier(field.name)
  const literal = quoteLiteral(value)
  return `CHECK (${column} ${operator} ${literal})`
}

const oneOfCheck = (field: TableField) => (values: ReadonlyArray<string | number>) => {
  const column = quoteIdentifier(field.name)
  const literals = Array.map(values, quoteLiteral)
  const list = Array.join(literals, ", ")
  return `CHECK (${column} IN (${list}))`
}

const lengthCheck = (operator: string) => (field: TableField) => (value: number) => {
  const column = quoteIdentifier(field.name)
  const literal = quoteLiteral(value)
  return `CHECK (length(${column}) ${operator} ${literal})`
}

const renderGreaterThan = (field: TableField) => (check: Extract<TableCheck, { _tag: "GreaterThan" }>) => {
  const compare = comparisonCheck(">")
  const render = compare(field)
  return render(check.value)
}

const renderGreaterThanOrEqualTo = (field: TableField) => (check: Extract<TableCheck, { _tag: "GreaterThanOrEqualTo" }>) => {
  const compare = comparisonCheck(">=")
  const render = compare(field)
  return render(check.value)
}

const renderLessThan = (field: TableField) => (check: Extract<TableCheck, { _tag: "LessThan" }>) => {
  const compare = comparisonCheck("<")
  const render = compare(field)
  return render(check.value)
}

const renderLessThanOrEqualTo = (field: TableField) => (check: Extract<TableCheck, { _tag: "LessThanOrEqualTo" }>) => {
  const compare = comparisonCheck("<=")
  const render = compare(field)
  return render(check.value)
}

const renderOneOf = (field: TableField) => (check: Extract<TableCheck, { _tag: "OneOf" }>) => {
  const render = oneOfCheck(field)
  return render(check.values)
}

const renderMinLength = (field: TableField) => (check: Extract<TableCheck, { _tag: "MinLength" }>) => {
  const length = lengthCheck(">=")
  const render = length(field)
  return render(check.value)
}

const renderMaxLength = (field: TableField) => (check: Extract<TableCheck, { _tag: "MaxLength" }>) => {
  const length = lengthCheck("<=")
  const render = length(field)
  return render(check.value)
}

const renderCheck = (field: TableField) => (check: TableCheck) => pipe(
  Match.value(check),
  Match.when({ _tag: "GreaterThan" }, renderGreaterThan(field)),
  Match.when({ _tag: "GreaterThanOrEqualTo" }, renderGreaterThanOrEqualTo(field)),
  Match.when({ _tag: "LessThan" }, renderLessThan(field)),
  Match.when({ _tag: "LessThanOrEqualTo" }, renderLessThanOrEqualTo(field)),
  Match.when({ _tag: "OneOf" }, renderOneOf(field)),
  Match.when({ _tag: "MinLength" }, renderMinLength(field)),
  Match.orElse(renderMaxLength(field)),
)

const uuidV7Default = `DEFAULT (lower(
  substr(printf('%012x', cast(unixepoch('subsec') * 1000 as integer)), 1, 8) || '-' ||
  substr(printf('%012x', cast(unixepoch('subsec') * 1000 as integer)), 9, 4) || '-7' ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', (random() & 3) + 1, 1) ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  hex(randomblob(6))
))`

export const renderColumn = (field: TableField, primaryKey: boolean) => {
  const fieldChecks = Array.map(field.checks, renderCheck(field))
  const scalarCheck = typeCheck(field)
  const checks = Array.prepend(fieldChecks, scalarCheck)
  const constraints = Array.join(checks, " ")
  const primaryKeyConstraint = primaryKey ? " PRIMARY KEY" : ""
  const nullability = field.nullable ? "" : " NOT NULL"
  const generated = Option.isSome(field.generation) ? ` ${uuidV7Default}` : ""
  const type = typeFor(field.scalar)
  const column = quoteIdentifier(field.name)
  return `${column} ${type}${primaryKeyConstraint}${nullability}${generated} ${constraints}`
}

const renderFields = (fields: ReadonlyArray<string>) => {
  const quoted = Array.map(fields, quoteIdentifier)
  return Array.join(quoted, ", ")
}

const renderUnique = (constraint: TableUnique) => {
  const fields = renderFields(constraint.fields)
  const name = quoteIdentifier(constraint.name)
  return `CONSTRAINT ${name} UNIQUE (${fields})`
}

const renderForeignKey = (constraint: TableForeignKey) => {
  const fields = renderFields(constraint.fields)
  const referenceFields = renderFields(constraint.references.fields)
  const name = quoteIdentifier(constraint.name)
  const table = quoteIdentifier(constraint.references.table)
  return `CONSTRAINT ${name} FOREIGN KEY (${fields}) REFERENCES ${table} (${referenceFields})`
}

const renderTableColumn = (identifier: string) => (field: TableField) => {
  const primaryKey = primaryKeyFor(identifier)(field)
  return renderColumn(field, primaryKey)
}

const primaryKeyFor = (identifier: string) => (field: TableField) =>
  Equivalence.strictEqual<string>()(field.name, identifier)

export const renderCreateTable = (table: TableSnapshot) => {
  const columns = Array.map(table.fields, renderTableColumn(table.identifier))
  const unique = Array.map(table.relations?.unique ?? [], renderUnique)
  const foreignKeys = Array.map(table.relations?.foreignKeys ?? [], renderForeignKey)
  const tableItems = Array.appendAll(columns, unique)
  const definitions = Array.appendAll(tableItems, foreignKeys)
  const rendered = Array.join(definitions, ", ")
  const name = quoteIdentifier(table.name)
  return `CREATE TABLE ${name} (${rendered})`
}

export const renderIndex = (table: string) => (index: TableIndex) => {
  const name = quoteIdentifier(index.name)
  const tableName = quoteIdentifier(table)
  const fields = renderFields(index.fields)
  return `CREATE INDEX ${name} ON ${tableName} (${fields})`
}

export const renderCreateIndexes = (table: TableSnapshot): readonly string[] =>
  Array.map(table.relations?.indexes ?? [], renderIndex(table.name))
