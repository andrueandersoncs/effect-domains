import { Equivalence } from "effect"
import type { TableField } from "./physical-table-field.ts"

export const isNumericTableScalar = (scalar: TableField["scalar"]) => {
  const integer = Equivalence.strictEqual<TableField["scalar"]>()(scalar, "integer")
  const number = Equivalence.strictEqual<TableField["scalar"]>()(scalar, "number")

  return integer || number
}
