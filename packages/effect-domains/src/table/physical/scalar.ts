import { Equivalence } from "effect"
import type { TableField } from "./field.ts"

export const isNumericTableScalar = (scalar: TableField["scalar"]) => {
  const integer = Equivalence.strictEqual<TableField["scalar"]>()(scalar, "integer")
  const number = Equivalence.strictEqual<TableField["scalar"]>()(scalar, "number")

  return integer || number
}

export const compatibleTableScalars = (source: TableField["scalar"], target: TableField["scalar"]) => {
  const same = Equivalence.strictEqual<TableField["scalar"]>()(source, target)
  const numeric = isNumericTableScalar(source) && isNumericTableScalar(target)

  return same || numeric
}
