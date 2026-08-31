import { describe, expect, test } from "bun:test"
import { Effect, Function, pipe, Ref, Schema } from "effect"
import { Query, Table } from "../index.ts"

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
    const incrementedRequest = decodedRequest + 1

    return String(incrementedRequest)
  },
)

const verifiesEncodingAndDecoding = Effect.gen(function* () {
  const implementedRequest = yield* Ref.make<unknown>(undefined)

  const implementation = (request: string) =>
    recordAndIncrement(implementedRequest, request)

  const query = Query.make(QueryRecords, {
    Request: Schema.NumberFromString,
    Result: Schema.NumberFromString,
    implementation,
  })

  const result = yield* query.execute(41)
  const observedRequest = yield* Ref.get(implementedRequest)

  expect(observedRequest).toBe("41")
  expect(result).toBe(42)
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

  const succeeded = yield* pipe(
    query.execute(Number.NaN),
    Effect.match({
      onFailure: Function.constant(false),
      onSuccess: Function.constant(true),
    }),
  )

  const called = yield* Ref.get(implementationCalled)

  expect(succeeded).toBeFalse()
  expect(called).toBeFalse()
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

const expectFailure = (succeeded: boolean) => {
  const expectation = expect(succeeded)
  expectation.toBeFalse()

  return succeeded
}

const expectQueryFailure = (error: unknown) => {
  const expectation = expect(error)
  expectation.toBe(QueryFailure)

  return error
}

describe("Query", () => {
  test("keeps its table, schemas, and implementation inspectable", () => {
    expect(InspectableQuery.table).toBe(QueryRecords)
    expect(InspectableQuery.Request).toBe(Schema.String)
    expect(InspectableQuery.Result).toBe(Schema.NumberFromString)
    expect(InspectableQuery.implementation).toBe(encodeRequestLength)
  })

  test("encodes the request before the implementation and decodes its result", () =>
    pipe(verifiesEncodingAndDecoding, Effect.runPromise))

  test("does not run the implementation when request encoding fails", () =>
    pipe(verifiesInvalidRequest, Effect.runPromise))

  test("fails when the implementation result does not match the result schema", () =>
    pipe(
      InvalidResultQuery.execute("request"),
      Effect.match({
        onFailure: Function.constant(false),
        onSuccess: Function.constant(true),
      }),
      Effect.runPromise,
    ).then(expectFailure))

  test("preserves implementation failures", () =>
    pipe(
      FailingQuery.execute("request"),
      Effect.flip,
      Effect.runPromise,
    ).then(expectQueryFailure))
})
