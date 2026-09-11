import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExpenseSchema } from "./domain.ts"

export const ExpensesResource = Resource.make({
  authorization: Authorization.public,
  name: "expenses",
  schema: ExpenseSchema,
  operations: {
    list: {
      filter: ["category"],
      range: ["date"],
      order: [["date", "asc"]],
    },
  },
})
