import { Context, Effect, Schema, SchemaGetter, pipe } from "effect"
import { NoteSchema } from "./domain.ts"

export class StoragePrefix extends Context.Service<
  StoragePrefix,
  { readonly value: string }
>()("examples/service-codec/StoragePrefix") {}

const decodeStoredText = SchemaGetter.transformOrFail<
  string,
  string,
  StoragePrefix
>(
  Effect.fn("StoredText.decode")(function* (value) {
    const prefix = yield* StoragePrefix
    return value.slice(prefix.value.length)
  }),
)

const encodeStoredText = SchemaGetter.transformOrFail<
  string,
  string,
  StoragePrefix
>(
  Effect.fn("StoredText.encode")(function* (value) {
    const prefix = yield* StoragePrefix
    return `${prefix.value}${value}`
  }),
)

export const StoredTextSchema = pipe(
  Schema.String,
  Schema.decodeTo(Schema.String, {
    decode: decodeStoredText,
    encode: encodeStoredText,
  }),
)

export const StoredNoteSchema = pipe(
  NoteSchema,
  Schema.fieldsAssign({ text: StoredTextSchema }),
)

interface StoredNote extends Schema.Schema.Type<typeof StoredNoteSchema> {}
