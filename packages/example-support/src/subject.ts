import { Schema } from "effect"

export const ExampleSubjectSchema = Schema.Struct({
  userId: Schema.String,
  tenantId: Schema.String,
  roles: Schema.Array(Schema.String),
})
