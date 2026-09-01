import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Function, Ref, Schema } from "effect"
import { Query, Table } from "../index.ts"

const RequestNumberBounds = Schema.isBetween({
  minimum: -1_000_000,
  maximum: 1_000_000,
})

const RequestNumberSchema = Schema.Int.check(RequestNumberBounds)

const QueryRecordSchema = Schema.Struct({
  value: Schema.String,
})

interface QueryRecord extends Schema.Schema.Type<typeof QueryRecordSchema> {}

const QueryRecords = Table.make(QueryRecordSchema, { name: "query_records" })

const encodeRequestLength = Effect.fn("QueryTest.encodeRequestLength")(
  function* (request: string) {
    return String(request.length)
  },
)

const InspectableQuery = Query.make(QueryRecords, {
  Request: Schema.String,
  Result: Schema.NumberFromString,
  implementation: encodeRequestLength,
})

const recordAndIncrement = Effect.fn("QueryTest.recordAndIncrement")(
  function* (implementedRequest: Ref.Ref<unknown>, request: string) {
    yield* Ref.set(implementedRequest, request)

    const decodedRequest = Number(request)
    return String(decodedRequest + 1)
  },
)

const verifiesEncodingAndDecoding = Effect.fn(
  "QueryTest.verifiesEncodingAndDecoding",
)(function* (request: number) {
  const implementedRequest = yield* Ref.make<unknown>(undefined)

  const implementation = (encodedRequest: string) =>
    recordAndIncrement(implementedRequest, encodedRequest)

  const query = Query.make(QueryRecords, {
    Request: Schema.NumberFromString,
    Result: Schema.NumberFromString,
    implementation,
  })

  const result = yield* query.execute(request)
  const observedRequest = yield* Ref.get(implementedRequest)
  const encodedRequest = String(request)
  expect(observedRequest).toBe(encodedRequest)
  expect(result).toBe(request + 1)
})

const markImplementationCalled = Effect.fn("QueryTest.markImplementationCalled")(
  function* (implementationCalled: Ref.Ref<boolean>, request: number) {
    yield* Ref.set(implementationCalled, true)

    return request
  },
)

const verifiesInvalidRequest = Effect.gen(function* () {
  const implementationCalled = yield* Ref.make(false)

  const implementation = (request: number) =>
    markImplementationCalled(implementationCalled, request)

  const query = Query.make(QueryRecords, {
    Request: Schema.Finite,
    Result: Schema.Number,
    implementation,
  })

  const execution = query.execute(Number.NaN)
  const result = yield* Effect.exit(execution)
  const called = yield* Ref.get(implementationCalled)
  const failed = Exit.isFailure(result)

  expect(failed).toBe(true)
  expect(called).toBe(false)
})

const returnInvalidResult = Effect.fn("QueryTest.returnInvalidResult")(
  function* () {
    return "not-a-number"
  },
)

const InvalidResultQuery = Query.make(QueryRecords, {
  Request: Schema.String,
  Result: Schema.Number,
  implementation: returnInvalidResult,
})

const QueryFailure = "operation failed" as const

const failQuery = Effect.fn("QueryTest.failQuery")(function* () {
  return yield* Effect.fail(QueryFailure)
})

const FailingQuery = Query.make(QueryRecords, {
  Request: Schema.String,
  Result: Schema.String,
  implementation: failQuery,
})

const verifiesInvalidResult = Effect.fn("QueryTest.verifiesInvalidResult")(
  function* () {
    const execution = InvalidResultQuery.execute("request")
    const result = yield* Effect.exit(execution)
    const failed = Exit.isFailure(result)

    expect(failed).toBe(true)
  },
)

const verifiesQueryFailure = Effect.fn("QueryTest.verifiesQueryFailure")(
  function* () {
    const execution = FailingQuery.execute("request")
    const failure = yield* Effect.flip(execution)

    expect(failure).toBe(QueryFailure)
  },
)

describe("Query", () => {
  it.effect("keeps its table, schemas, and implementation inspectable", () =>
    Effect.sync(() => {
      expect(InspectableQuery.table).toBe(QueryRecords)
      expect(InspectableQuery.Request).toBe(Schema.String)
      expect(InspectableQuery.Result).toBe(Schema.NumberFromString)
      expect(InspectableQuery.implementation).toBe(encodeRequestLength)
    }))

  it.effect.prop(
    "encodes the request before the implementation and decodes its result",
    [RequestNumberSchema],
    ([request]) => verifiesEncodingAndDecoding(request),
  )

  it.effect(
    "does not run the implementation when request encoding fails",
    Function.constant(verifiesInvalidRequest),
  )

  it.effect(
    "fails when the implementation result does not match the result schema",
    verifiesInvalidResult,
  )

  it.effect("preserves implementation failures", verifiesQueryFailure)
})
