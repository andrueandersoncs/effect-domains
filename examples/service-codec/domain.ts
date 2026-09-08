import { Schema, pipe } from "effect"
import { identifier } from "effect-domains/domain"

export const NoteIdSchema = pipe(
  Schema.String,
  Schema.brand("NoteId"),
  identifier,
)

export const NoteSchema = Schema.Struct({
  id: NoteIdSchema,
  text: Schema.String,
})

export interface Note extends Schema.Schema.Type<typeof NoteSchema> {}

