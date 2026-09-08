import { Resource } from "effect-domains/resource"
import { TodoSchema } from "./domain.ts"

export const TodosResource = Resource.make({
  name: "todos",
  schema: TodoSchema,
  create: {
    defaults: { completed: false },
  },
  list: {
    filter: ["completed"],
    order: [{ field: "title" }],
    limit: 25,
  },
  operations: [...Resource.crud, "patch"] as const,
})
