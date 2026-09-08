import { Resource } from "effect-domains/resource"
import { TodoSchema } from "./domain.ts"

export const TodosResource = Resource.make({
  name: "todos",
  schema: TodoSchema,
  operations: ["get", "list", "create", "update", "remove"],
})
