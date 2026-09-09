import { Array, Equivalence, Match, Option, Predicate, Schema, pipe } from "effect"
import type { TableCheck, TableField, TableSnapshot } from "./table.ts"

const quoteIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`

const quoteLiteral = (value: string | number) => {
  if (Predicate.isString(value)) {
    return `'${value.replaceAll("'", "''")}'`
  }

  const finite = Schema.Finite.make(value)

  return String(finite)
}

const columnTypes: Readonly<Record<TableField["scalar"], string>> = {
  string: "TEXT",
  integer: "INTEGER",
  number: "REAL",
}

const columnType = (scalar: TableField["scalar"]) => columnTypes[scalar]

const typeExpression = (column: string, scalar: TableField["scalar"]) =>
  pipe(
    Match.value(scalar),
    Match.when("string", () => `typeof(${column}) = 'text'`),
    Match.when("integer", () => `typeof(${column}) = 'integer'`),
    Match.when("number", () => `typeof(${column}) IN ('integer', 'real')`),
    Match.exhaustive,
  )

const typeCheck = (field: TableField) => {
  const column = quoteIdentifier(field.name)
  const expression = typeExpression(column, field.scalar)

  return field.nullable
    ? `CHECK (${column} IS NULL OR ${expression})`
    : `CHECK (${expression})`
}

const renderCheck = (field: TableField, check: TableCheck) => {
  const column = quoteIdentifier(field.name)

  return pipe(
    Match.value(check),
    Match.tagsExhaustive({
      GreaterThan: ({ value }) => `CHECK (${column} > ${quoteLiteral(value)})`,
      GreaterThanOrEqualTo: ({ value }) =>
        `CHECK (${column} >= ${quoteLiteral(value)})`,
      LessThan: ({ value }) => `CHECK (${column} < ${quoteLiteral(value)})`,
      LessThanOrEqualTo: ({ value }) =>
        `CHECK (${column} <= ${quoteLiteral(value)})`,
      OneOf: ({ values }) => {
        const quotedValues = Array.map(values, quoteLiteral)

        return `CHECK (${column} IN (${Array.join(quotedValues, ", ")}))`
      },
      MinLength: ({ value }) => `CHECK (length(${column}) >= ${quoteLiteral(value)})`,
      MaxLength: ({ value }) => `CHECK (length(${column}) <= ${quoteLiteral(value)})`,
    }),
  )
}

const uuidV7Default = `DEFAULT (lower(
  substr(printf('%012x', cast(unixepoch('subsec') * 1000 as integer)), 1, 8) || '-' ||
  substr(printf('%012x', cast(unixepoch('subsec') * 1000 as integer)), 9, 4) || '-7' ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', (random() & 3) + 1, 1) ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  hex(randomblob(6))
))`

export const renderColumn = (
  field: TableField,
  primaryKey: boolean,
) => {
  const primaryKeyConstraint = primaryKey
    ? " PRIMARY KEY"
    : ""

  const nullability = field.nullable ? "" : " NOT NULL"
  const generated = Option.isSome(field.generation) ? ` ${uuidV7Default}` : ""
  const renderedChecks = Array.map(field.checks, (check) => renderCheck(field, check))
  const fieldTypeCheck = typeCheck(field)

  const checks = Array.prepend(
    renderedChecks,
    fieldTypeCheck,
  )

  return `${quoteIdentifier(field.name)} ${columnType(field.scalar)}${primaryKeyConstraint}${nullability}${generated} ${Array.join(checks, " ")}`
}

export const renderCreateTable = (table: TableSnapshot) => {
  const identifierEquals = Equivalence.strictEqual<string>()

  const renderTableColumn = (field: TableField) => {
    const primaryKey = identifierEquals(field.name, table.identifier)
    return renderColumn(field, primaryKey)
  }

  const columns = Array.map(table.fields, renderTableColumn)

  return `CREATE TABLE ${quoteIdentifier(table.name)} (${Array.join(columns, ", ")})`
}
