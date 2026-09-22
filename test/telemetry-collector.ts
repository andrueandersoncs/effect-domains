import { Array, Data, Effect, Equivalence, Function, HashMap, Match, Option, Ref, Schema, Struct, flow, pipe } from "effect"

type CollectorMode = "accept" | "retry-twice" | "slow"

const NullableStringSchema = Schema.NullOr(Schema.String)

export class CollectedSignal extends Schema.Class<CollectedSignal>("CollectedSignal")({
  path: Schema.String,
  authorization: NullableStringSchema,
  body: Schema.Uint8Array,
  status: Schema.Int,
  attempt: Schema.Int,
}) {}

export const decodeSignalBody = (body: Uint8Array) => new TextDecoder().decode(body)

class TelemetryCollector extends Data.Class<{
  readonly endpoint: string
  readonly received: Effect.Effect<ReadonlyArray<CollectedSignal>>
  readonly attempts: Effect.Effect<HashMap.HashMap<string, number>>
}> {}

class CollectorLease extends Data.Class<{
  readonly collector: TelemetryCollector
  readonly close: Effect.Effect<void>
}> {}

class CollectorWebHandler extends Data.Class<{
  readonly handler: (request: Request) => Promise<Response>
}> {}

class CollectorServerOptions extends Data.Class<{
  readonly hostname: string
  readonly port: number
  readonly fetch: (request: Request) => Promise<Response>
}> {}




const makeTelemetryCollector = Effect.fn("TelemetryCollector.make")(function* (
  mode: CollectorMode,
) {
  const noSignals = Array.empty<CollectedSignal>()
  const noAttempts = HashMap.empty<string, number>()
  const received = yield* Ref.make<ReadonlyArray<CollectedSignal>>(noSignals)
  const attempts = yield* Ref.make(noAttempts)

  const handle = Effect.fn("TelemetryCollector.handle")(function* (request: Request) {
    const url = new URL(request.url)

    const attempt = yield* Ref.modify(attempts, (current) => {
      const previous = pipe(HashMap.get(current, url.pathname), Option.getOrElse(Function.constant(0)))
      const next = previous + 1

      return [next, HashMap.set(current, url.pathname, next)] as const
    })

    const retryStatus = pipe(
      Match.value(attempt),
      Match.when(1, Function.constant(429)),
      Match.when(2, Function.constant(503)),
      Match.orElse(Function.constant(200)),
    )

    const status = Equivalence.strictEqual<CollectorMode>()(mode, "retry-twice") ? retryStatus : 200

    if (Equivalence.strictEqual<CollectorMode>()(mode, "slow")) yield* Effect.sleep("5 seconds")

    const buffer = yield* Effect.promise(() => request.arrayBuffer())
    const body = new Uint8Array(buffer)
    const authorization = request.headers.get("authorization")
    const signal = CollectedSignal.make({ path: url.pathname, authorization, body, status, attempt })

    yield* Ref.update(received, Array.append(signal))

    const throttled = Equivalence.strictEqual<number>()(status, 429)

    return new Response(body, {
      status,
      headers: throttled
        ? { "content-type": "application/x-protobuf", "retry-after": "0" }
        : { "content-type": "application/x-protobuf" },
    })
  })

  const fetch = flow(handle, Effect.runPromise)
  const web = new CollectorWebHandler({ handler: fetch })

  const serverOptions = new CollectorServerOptions({
    hostname: "127.0.0.1",
    port: 0,
    fetch: web.handler,
  })

  const server = Bun.serve(serverOptions)
  const endpoint = `http://127.0.0.1:${server.port}`
  const receivedEffect = Ref.get(received)
  const attemptsEffect = Ref.get(attempts)

  const collector = new TelemetryCollector({
    endpoint,
    received: receivedEffect,
    attempts: attemptsEffect,
  })

  const close = Effect.sync(() => server.stop(true))

  return new CollectorLease({ collector, close })
})

export const telemetryCollector = Effect.fn("TelemetryCollector.scoped")(function* (
  mode: CollectorMode = "accept",
) {
  const acquire = makeTelemetryCollector(mode)
  const lease = yield* Effect.acquireRelease(acquire, Struct.get("close"))

  return lease.collector
})
