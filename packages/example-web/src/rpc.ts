import { Effect, Equivalence, Predicate, Schema, pipe } from "effect"

export class ExampleWebRpcError extends Schema.TaggedError<ExampleWebRpcError>()("ExampleWebRpcError", {
  message: Schema.String,
}) {}

const TaggedErrorSchema = Schema.Struct({
  _tag: Schema.String,
})

const sameString = Equivalence.strictEqual<string>()

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

const EnvelopeSchema = Schema.Array(Schema.Struct({
  _tag: Schema.String,
  exit: Schema.optionalKey(Schema.Unknown),
  defect: Schema.optionalKey(Schema.Unknown),
}))

const ExitSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Success"),
    value: Schema.Unknown,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Failure"),
    cause: Schema.Unknown,
  }),
])

const unwrapCause = (cause: unknown): unknown => {
  if (Array.isArray(cause)) {
    const first = cause[0]
    return first === undefined ? cause : unwrapCause(first)
  }
  if (!Predicate.isObject(cause)) return cause
  if (Predicate.hasProperty(cause, "_tag") && Predicate.isString(cause._tag)) {
    if (sameString(cause._tag, "Fail") && Predicate.hasProperty(cause, "error")) {
      return unwrapCause(cause.error)
    }
    if (sameString(cause._tag, "Die") && Predicate.hasProperty(cause, "defect")) {
      return unwrapCause(cause.defect)
    }
  }
  if (Predicate.hasProperty(cause, "failures") && Array.isArray(cause.failures)) {
    const first = cause.failures[0]
    if (first !== undefined) return unwrapCause(first)
  }
  if (Predicate.hasProperty(cause, "cause")) return unwrapCause(cause.cause)
  return cause
}

const causeFailure = unwrapCause

let requestId = 0

const nextRequestId = () => {
  requestId += 1
  return requestId
}

const asRpcError = (error: unknown) => {
  if (error instanceof ExampleWebRpcError) return error
  return ExampleWebRpcError.make({ message: formatRpcError(error) })
}

const decodeEnvelope = Schema.decodeUnknownEffect(EnvelopeSchema)
const decodeExit = Schema.decodeUnknownEffect(ExitSchema)

export const rpcCall = <Success>(options: Readonly<{
  tag: string
  payload: unknown
  token: string | null
  success: Schema.Codec<Success>
}>) => {
  const decodeSuccess = Schema.decodeUnknownEffect(options.success)

  return Effect.gen(function* () {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (options.token !== null) headers.authorization = `Bearer ${options.token}`

    const response = yield* Effect.tryPromise({
      try: () => fetch(`${globalThis.location.origin}/rpc/v1/`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          _tag: "Request",
          id: nextRequestId(),
          tag: options.tag,
          payload: options.payload,
          headers: [],
        }),
      }),
      catch: asRpcError,
    })

    if (!response.ok) {
      return yield* ExampleWebRpcError.make({ message: `RPC HTTP ${response.status}` })
    }

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: asRpcError,
    })

    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: asRpcError,
    })

    const envelopes = yield* pipe(decodeEnvelope(parsed), Effect.mapError(asRpcError))
    const envelope = envelopes[0]
    if (envelope === undefined) {
      return yield* ExampleWebRpcError.make({ message: "Empty RPC response" })
    }

    if (sameString(envelope._tag, "Defect")) {
      return yield* ExampleWebRpcError.make({ message: formatRpcError(envelope.defect) })
    }

    const exit = yield* pipe(decodeExit(envelope.exit), Effect.mapError(asRpcError))
    if (exit._tag === "Failure") {
      return yield* ExampleWebRpcError.make({ message: formatRpcError(causeFailure(exit.cause)) })
    }

    return yield* pipe(decodeSuccess(exit.value), Effect.mapError(asRpcError))
  })
}

export const matchRpc = <Success, Message>(
  effect: Effect.Effect<Success, ExampleWebRpcError>,
  onSuccess: (value: Success) => Message,
  onFailure: (error: ExampleWebRpcError) => Message,
) => pipe(effect, Effect.match({ onSuccess, onFailure }))
