import { Schema } from "effect"

export const TodoSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  completed: Schema.Boolean,
  tenantId: Schema.String,
  ownerId: Schema.String,
})

interface Todo extends Schema.Schema.Type<typeof TodoSchema> {}
