import { Effect, Layer, Predicate, Schema, pipe } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"


const TaggedErrorSchema = Schema.Struct({
  _tag: Schema.String,
})


const deepestMessage = (error: unknown): string | null => {
  if (Predicate.isString(error) && error.length > 0) return error
  if (!Predicate.isObject(error)) return null
  if (Predicate.hasProperty(error, "cause")) {
    const nested = deepestMessage(error.cause)
    if (nested !== null) return nested
  }
  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message) && error.message.length > 0) {
    return error.message
  }
  return null
}

export const formatRpcError = (error: unknown) => {
  const deep = deepestMessage(error)
  if (deep !== null) return deep
  if (Schema.is(TaggedErrorSchema)(error)) return error._tag
  return JSON.stringify(error)
}

export const browserProtocol = pipe(
  Layer.unwrap(Effect.sync(() => RpcClient.layerProtocolHttp({
    url: new URL("/rpc/v1", globalThis.location.href).href,
  }))),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerJson),
)

export const browserLayer = <I, E, R>(client: {
  readonly layerProtocol: Layer.Layer<I, E, R>
}) => pipe(client.layerProtocol, Layer.provide(browserProtocol))

export const bearer = (token: string | null): Readonly<{ headers: Readonly<Record<string, string>> }> => ({
  headers: token === null || token === "" ? {} : { authorization: `Bearer ${token}` },
})
