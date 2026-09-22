import { Context, Effect, Schema, SchemaGetter, pipe } from "effect"

export class StoragePrefix extends Context.Service<StoragePrefix, { readonly value: string }>()("test/StoragePrefix") {}

const decode = SchemaGetter.transformOrFail<string, string, StoragePrefix>(
  Effect.fn("Prefix.decode")(function* (value) {
    const prefix = yield* StoragePrefix

    return value.slice(prefix.value.length)
  }),
)

const encode = SchemaGetter.transformOrFail<string, string, StoragePrefix>(
  Effect.fn("Prefix.encode")(function* (value) {
    const prefix = yield* StoragePrefix

    return `${prefix.value}${value}`
  }),
)

export const StoredTextSchema = pipe(Schema.String, Schema.decodeTo(Schema.String, { decode, encode }))
