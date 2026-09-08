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

export const NoteIdInputSchema = Schema.Struct({ id: NoteIdSchema })

export interface NoteIdInput extends Schema.Schema.Type<
  typeof NoteIdInputSchema
> {}

export const EmptyInputSchema = Schema.Struct({})

interface EmptyInput extends Schema.Schema.Type<typeof EmptyInputSchema> {}

export class NoteNotFound extends Schema.TaggedError<NoteNotFound>()(
  "NoteNotFound",
  { id: NoteIdSchema },
) {}

export class NotesPersistenceFailure extends Schema.TaggedError<NotesPersistenceFailure>()(
  "NotesPersistenceFailure",
  { operation: Schema.String },
) {}
