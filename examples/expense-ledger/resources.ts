import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExpenseSchema } from "./domain.ts"

export const ExpensesResource = Resource.define({
  authorization: Authorization.public,
  name: "expenses",
  schema: ExpenseSchema,
  capabilities: Resource.capabilities(
    Resource.list({
      filter: ["category"],
      range: ["date"],
      order: [["date", "asc"]],
    }),
  ),
})
