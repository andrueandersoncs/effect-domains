import { Schema } from "effect"

export const TodoSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  completed: Schema.Boolean,
})

interface Todo extends Schema.Schema.Type<typeof TodoSchema> {}
