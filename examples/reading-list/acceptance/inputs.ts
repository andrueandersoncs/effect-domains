import { Effect, Order, Schema, SchemaAST } from "effect"
import { FastCheck } from "effect/testing"
import { type RpcGroup, RpcSchema } from "effect/unstable/rpc"
import { ReadingListApplication } from "../application.ts"
import { AcceptanceError, PayloadSchema, type Candidate, type Payload, type Scenario } from "./model.ts"
import { readingListCatalog } from "./catalog.ts"

type NativeOperation = RpcGroup.Rpcs<typeof ReadingListApplication.group>

const failure = (boundary: string, message: string) => new AcceptanceError({ boundary, message })
const describe = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const parseOptions = { onExcessProperty: "error" } as const

export const resolveOperation = Effect.fn("acceptance.resolveOperation")(function* (name: string) {
  const matches = [...ReadingListApplication.group.requests.values()].filter((request) => request._tag === name)
  if (matches.length !== 1) {
    return yield* failure("inputs.operation", `Expected exactly one native operation ${name}; found ${matches.length}`)
  }
  const procedure = matches[0]!
  if (RpcSchema.isStreamSchema(procedure.successSchema)) {
    return yield* failure("inputs.unsupported", `Operation ${name} is not unary`)
  }
  return procedure
})

const objectShape = (schema: Schema.Constraint): SchemaAST.Objects => {
  const ast = SchemaAST.toType(schema.ast)
  if (ast._tag !== "Objects" || ast.indexSignatures.length > 0 || ast.propertySignatures.some((field) => typeof field.name !== "string")) {
    throw failure("inputs.unsupported", "Candidate generation requires a native object with named string fields and no index signatures")
  }
  return ast
}

// Native arbitrary currently visits Never even when its object key is optional.
// Construct the record generator, not a different operation schema: every other
// field retains its native decoded AST and the entire native contract validates it.
const deriveArbitrary = (schema: Schema.Constraint) => {
  const ast = objectShape(schema)
  const fields: Record<string, FastCheck.Arbitrary<unknown>> = {}
  const requiredKeys: Array<string> = []
  for (const field of ast.propertySignatures) {
    if (field.type._tag === "Never" && SchemaAST.isOptional(field.type)) continue
    const name = String(field.name)
    fields[name] = Schema.toArbitrary(Schema.make(field.type))(FastCheck)
    if (!SchemaAST.isOptional(field.type)) requiredKeys.push(name)
  }
  return FastCheck.record(fields, { requiredKeys }).filter(Schema.is(Schema.toType(schema)))
}

const generate = Effect.fn("acceptance.generateInputs")(function* (schema: Schema.Constraint, seed: number, count: number) {
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(count) || count < 1) {
    return yield* failure("inputs.unsupported", "Sampling requires an integer seed and a positive integer count")
  }
  const arbitrary = yield* Effect.try({
    try: () => deriveArbitrary(schema),
    catch: (cause) => cause instanceof AcceptanceError ? cause : failure("inputs.unsupported", describe(cause)),
  })
  return yield* Effect.try({
    try: () => FastCheck.sample(arbitrary, { seed, numRuns: count, maxSkipsPerRun: 100 }),
    catch: (cause) => failure("inputs.exhausted", `Native arbitrary could not supply ${count} candidates: ${describe(cause)}`),
  })
})

const supportedOperation = Effect.fn("acceptance.supportedInputOperation")(function* (name: string) {
  const operation = yield* resolveOperation(name)
  if (name !== "books.create" && name !== "books.update") {
    return yield* failure("inputs.unsupported", `No input strategy binding exists for ${name}`)
  }
  return operation
})

const nativeEncode = Effect.fn("acceptance.nativeEncode")(function* (
  operation: NativeOperation,
  decoded: unknown,
) {
  const encoded = yield* Schema.encodeUnknownEffect(operation.payloadSchema, parseOptions)(decoded).pipe(
    Effect.mapError((cause) => failure("inputs.native-encode", describe(cause))),
  )
  return yield* Schema.decodeUnknownEffect(PayloadSchema)(encoded).pipe(
    Effect.mapError((cause) => failure("inputs.unsupported", `Native encoding is not an object payload: ${describe(cause)}`)),
  )
})

export const sampleOperation = Effect.fn("acceptance.sampleOperation")(function* (
  name: string,
  seed: number,
  count: number,
): Effect.fn.Return<ReadonlyArray<Candidate>, AcceptanceError> {
  const operation = yield* supportedOperation(name)
  const values = yield* generate(operation.payloadSchema, seed, count)
  const omittedFields = objectShape(operation.payloadSchema).propertySignatures
    .filter((field) => field.type._tag === "Never" && SchemaAST.isOptional(field.type))
    .map((field) => String(field.name))
  return yield* Effect.forEach(values, Effect.fn("acceptance.validateSample")(function* (value) {
    const input = yield* nativeEncode(operation, value)
    const decoded = yield* Schema.decodeUnknownEffect(operation.payloadSchema, parseOptions)(input).pipe(
      Effect.mapError((cause) => failure("inputs.native-decode", describe(cause))),
    )
    return {
      input, decoded, seed, strategy: "sample", valid: true,
      source: "native decoded-AST structural arbitrary; title/author usefulness not established",
      nativeValidation: "accepted by the exact native operation codec after encoding",
      omittedFields,
    }
  }))
})

const visitChecks = (checks: SchemaAST.Checks | undefined, visit: (check: SchemaAST.Check<unknown>) => void) => {
  for (const check of checks ?? []) {
    visit(check)
    if (check._tag === "FilterGroup") visitChecks(check.checks, visit)
  }
}

const ratingBounds = (schema: Schema.Constraint) => {
  const shape = schema.ast
  if (shape._tag !== "Objects" || shape.encoding) {
    throw failure("inputs.unsupported", "Rating strategies do not flatten transformed operation payloads")
  }
  const rating = shape.propertySignatures.find((field) => field.name === "rating")?.type
  if (!rating || rating._tag !== "Union" || rating.encoding || rating.checks ||
    rating.types.length !== 2 || !rating.types.some((member) => member._tag === "Null")) {
    throw failure("inputs.unsupported", "Rating strategies require the native nullable numeric field without a field-level transformation")
  }
  const numeric = rating.types.find((member) => member._tag === "Number")
  if (!numeric || numeric.encoding) {
    throw failure("inputs.unsupported", "Rating strategies require an untransformed native number branch")
  }
  let minimum = -Infinity
  let maximum = Infinity
  let integer = false
  visitChecks(numeric.checks, (check) => {
    const constraint = check.annotations?.arbitrary?.constraint
    integer ||= constraint?.integer === true
    const ordered = constraint?.ordered
    if (ordered?.order !== Order.Number) return
    if (ordered.minimum !== undefined) {
      if (typeof ordered.minimum !== "number" || ordered.exclusiveMinimum) {
        throw failure("inputs.unsupported", "Rating strategies require inclusive numeric lower constraints")
      }
      minimum = Math.max(minimum, ordered.minimum)
    }
    if (ordered.maximum !== undefined) {
      if (typeof ordered.maximum !== "number" || ordered.exclusiveMaximum) {
        throw failure("inputs.unsupported", "Rating strategies require inclusive numeric upper constraints")
      }
      maximum = Math.min(maximum, ordered.maximum)
    }
  })
  if (!integer || !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum >= maximum) {
    throw failure("inputs.unsupported", "Rating strategies require native integer checks and distinct finite inclusive bounds")
  }
  return { minimum, maximum }
}

export const makeCandidate = Effect.fn("acceptance.makeCandidate")(function* (
  scenario: Scenario,
  seed: number,
  target?: Payload,
): Effect.fn.Return<Candidate, AcceptanceError> {
  const operation = yield* supportedOperation(scenario.operation)
  if (!Number.isSafeInteger(seed)) {
    return yield* failure("inputs.unsupported", "Candidate generation requires an integer seed")
  }
  let sample: Candidate
  if (scenario.operation === "books.update") {
    if (!target || !Object.hasOwn(target, "id")) {
      return yield* failure("inputs.fixture", "books.update requires a complete fixture target with its existing identity")
    }
    const decodedTarget = yield* Schema.decodeUnknownEffect(operation.payloadSchema, parseOptions)(target).pipe(
      Effect.mapError((cause) => failure("inputs.fixture", `Fixture target violates native update contract: ${describe(cause)}`)),
    )
    const baseline = yield* nativeEncode(operation, decodedTarget)
    sample = {
      input: baseline, decoded: decodedTarget, seed, strategy: scenario.strategy, valid: true,
      source: "complete fixture target; native codec validated; no generated identity",
      nativeValidation: "accepted by the exact native operation codec after fixture encoding",
      omittedFields: [],
    }
  } else {
    const samples = yield* sampleOperation(scenario.operation, seed, 1)
    sample = samples[0]!
  }
  const input: Record<string, unknown> = { ...sample.input }
  if (scenario.textFixture) {
    const fixture = readingListCatalog.textFixtures.find((item) => item.id === scenario.textFixture)
    if (!fixture || scenario.operation !== "books.create") return yield* failure("inputs.fixture", `Unavailable text fixture binding ${scenario.textFixture}`)
    Object.assign(input, fixture.values)
    sample = { ...sample, source: `${sample.source}; semantic text from ${fixture.id}@${fixture.revision} (${fixture.provenance})` }
  }
  if (scenario.strategy === "sample") {
    if (scenario.operation === "books.update") {
      const arbitrary = yield* Effect.try({
        try: () => {
          const rating = objectShape(operation.payloadSchema).propertySignatures.find((field) => field.name === "rating")
          if (!rating) throw failure("inputs.unsupported", "Native update contract has no rating field")
          return Schema.toArbitrary(Schema.make(rating.type))(FastCheck)
        },
        catch: (cause) => cause instanceof AcceptanceError ? cause : failure("inputs.unsupported", describe(cause)),
      })
      const ratings = yield* Effect.try({
        try: () => FastCheck.sample(arbitrary, { seed, numRuns: 1, maxSkipsPerRun: 100 }),
        catch: (cause) => failure("inputs.exhausted", `Native rating arbitrary could not supply a candidate: ${describe(cause)}`),
      })
      const decodedBaseline = yield* Schema.decodeUnknownEffect(PayloadSchema)(sample.decoded).pipe(
        Effect.mapError((cause) => failure("inputs.unsupported", `Native decoded update is not an object: ${describe(cause)}`)),
      )
      const encodedSample = yield* nativeEncode(operation, { ...decodedBaseline, rating: ratings[0] })
      input.rating = encodedSample.rating
      sample = { ...sample, source: `${sample.source}; native decoded-AST rating arbitrary` }
    }
  } else if (scenario.strategy === "null") {
    input.rating = null
  } else if (scenario.strategy === "omitted") {
    delete input.rating
  } else {
    const bounds = yield* Effect.try({
      try: () => ratingBounds(operation.payloadSchema),
      catch: (cause) => cause instanceof AcceptanceError ? cause : failure("inputs.unsupported", describe(cause)),
    })
    switch (scenario.strategy) {
      case "minimum": input.rating = bounds.minimum; break
      case "maximum": input.rating = bounds.maximum; break
      case "below": input.rating = bounds.minimum - 1; break
      case "above": input.rating = bounds.maximum + 1; break
      case "fractional": input.rating = bounds.minimum + 0.5; break
    }
  }
  const validation = yield* Schema.decodeUnknownEffect(operation.payloadSchema, parseOptions)(input).pipe(Effect.result)
  const expectsValid = scenario.expected === "accepted"
  if (validation._tag === "Success" && !expectsValid) {
    return yield* failure("inputs.unsupported", `Strategy ${scenario.strategy} did not violate the native operation contract`)
  }
  if (validation._tag === "Failure" && expectsValid) {
    return yield* failure("inputs.exhausted", `Strategy ${scenario.strategy} did not produce a native-valid candidate: ${describe(validation.failure)}`)
  }
  if (validation._tag === "Success") {
    const encoded = yield* nativeEncode(operation, validation.success)
    const decoded = yield* Schema.decodeUnknownEffect(operation.payloadSchema, parseOptions)(encoded).pipe(
      Effect.mapError((cause) => failure("inputs.native-decode", describe(cause))),
    )
    return { ...sample, input: encoded, decoded, strategy: scenario.strategy,
      omittedFields: scenario.strategy === "omitted" ? [...sample.omittedFields, "rating"] : sample.omittedFields,
      source: `${sample.source}; native rating strategy ${scenario.strategy}${target ? "; fixture target identity and unchanged fields" : ""}` }
  }
  // Deliberately retain the invalid candidate for the actual browser submission;
  // encoding it as if it were valid would hide the rejection path under test.
  return {
    ...sample, input, decoded: undefined, strategy: scenario.strategy, valid: false,
    source: `${sample.source}; deliberate native-contract violation (${scenario.strategy})${target ? "; fixture target identity and unchanged fields" : ""}`,
    nativeValidation: `rejected by the exact native operation codec: ${describe(validation.failure)}`,
    omittedFields: scenario.strategy === "omitted" ? [...sample.omittedFields, "rating"] : sample.omittedFields,
  }
})

export const replayCandidate = Effect.fn("acceptance.replayCandidate")(function* (
  scenario: Scenario,
  recorded: Candidate,
  target?: Payload,
): Effect.fn.Return<Candidate, AcceptanceError> {
  const operation = yield* supportedOperation(scenario.operation)
  const expectsValid = scenario.expected === "accepted"
  if (recorded.strategy !== scenario.strategy || recorded.valid !== expectsValid) {
    return yield* failure("inputs.replay", "Recorded candidate strategy or validity disagrees with the replay scenario")
  }
  const input: Record<string, unknown> = { ...recorded.input }
  if (scenario.operation === "books.create" && Object.hasOwn(input, "id")) {
    return yield* failure("inputs.replay", "A create replay must never supply the forbidden generated identity")
  }
  if (scenario.operation === "books.update") {
    if (!target || !Object.hasOwn(target, "id")) {
      return yield* failure("inputs.fixture", "An update replay requires the fresh fixture target identity")
    }
    yield* Schema.decodeUnknownEffect(operation.payloadSchema, parseOptions)(target).pipe(
      Effect.mapError((cause) => failure("inputs.fixture", `Fresh replay target violates native update contract: ${describe(cause)}`)),
    )
    input.id = target.id
  }
  const validation = yield* Schema.decodeUnknownEffect(operation.payloadSchema, parseOptions)(input).pipe(Effect.result)
  if ((validation._tag === "Success") !== expectsValid) {
    return yield* failure("inputs.replay", `Recorded input has the wrong native validity for strategy ${scenario.strategy}`)
  }
  if (validation._tag === "Success") {
    yield* nativeEncode(operation, validation.success)
    return {
      ...recorded, input, decoded: validation.success, valid: true,
      nativeValidation: "accepted by the exact native operation codec during concrete-input replay",
    }
  }
  // A rejected replay must still be an otherwise-valid book, not a malformed
  // record that happens to reject for a different field or missing identity.
  yield* Schema.decodeUnknownEffect(operation.payloadSchema, parseOptions)({ ...input, rating: null }).pipe(
    Effect.mapError((cause) => failure("inputs.replay", `Replayed rejection is not isolated to rating: ${describe(cause)}`)),
  )
  return {
    ...recorded, input, decoded: undefined, valid: false,
    nativeValidation: `rejected by the exact native operation codec during concrete-input replay: ${describe(validation.failure)}`,
  }
})
