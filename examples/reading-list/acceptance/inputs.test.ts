import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { RatingSchema } from "../domain.ts"
import { makeCandidate, replayCandidate, resolveOperation, sampleOperation } from "./inputs.ts"
import { PayloadSchema, type Payload, type Scenario } from "./model.ts"

const scenario = (strategy: Scenario["strategy"], operation = "books.create"): Scenario => ({
  id: `input-${operation}-${strategy}`,
  revision: "1",
  provenance: "native-input regression",
  approval: "approved",
  story: "input-regression",
  operation,
  resource: "books",
  fixture: "isolated-reading-list",
  actor: "public-reader",
  goal: "Exercise the exact native operation contract",
  strategy,
  expected: ["below", "above", "fractional"].includes(strategy) || (strategy === "omitted" && operation === "books.update") ? "rejected" : "accepted",
  requirements: [],
  reload: false,
})

it.effect("create generation omits optional Never without weakening the original native codec", () => Effect.gen(function* () {
  const operation = yield* resolveOperation("books.create")
  const candidates = yield* sampleOperation("books.create", 20261008, 32)
  expect(candidates).toHaveLength(32)
  for (const candidate of candidates) {
    expect(Object.hasOwn(candidate.input, "id")).toBe(false)
    expect(candidate.omittedFields).toContain("id")
    expect(candidate.valid).toBe(true)
    const decoded = yield* Schema.decodeUnknownEffect(operation.payloadSchema)(candidate.input)
    expect(decoded).toEqual(candidate.decoded)
    const suppliedId = yield* Schema.decodeUnknownEffect(operation.payloadSchema)({ ...candidate.input, id: "forbidden" }).pipe(Effect.result)
    expect(suppliedId._tag).toBe("Failure")
  }
  const repeated = yield* sampleOperation("books.create", 20261008, 32)
  expect(repeated).toEqual(candidates)
}))

it.effect("rating boundaries and null satisfy the exact native codec while rejection candidates remain invalid", () => Effect.gen(function* () {
  const operation = yield* resolveOperation("books.create")
  const minimum = yield* makeCandidate(scenario("minimum"), 11)
  const maximum = yield* makeCandidate(scenario("maximum"), 11)
  expect(minimum.input.rating).toBe(1)
  expect(maximum.input.rating).toBe(5)
  expect(Schema.is(RatingSchema)(minimum.input.rating)).toBe(true)
  expect(Schema.is(RatingSchema)(maximum.input.rating)).toBe(true)
  const nullable = yield* makeCandidate(scenario("null"), 11)
  expect(nullable.input.rating).toBe(null)
  expect(nullable.valid).toBe(true)
  yield* Schema.decodeUnknownEffect(operation.payloadSchema)(nullable.input)

  for (const strategy of ["below", "above", "fractional"] as const) {
    const candidate = yield* makeCandidate(scenario(strategy), 11)
    const decoded = yield* Schema.decodeUnknownEffect(operation.payloadSchema)(candidate.input).pipe(Effect.result)
    expect(decoded._tag).toBe("Failure")
    expect(candidate.valid).toBe(false)
    expect(candidate.decoded).toBeUndefined()
    expect(Schema.is(RatingSchema)(candidate.input.rating)).toBe(false)
  }
}))

it.effect("create omission is native-valid and preserves omitted nullable fields through encoding and replay", () => Effect.gen(function* () {
  const declaration = scenario("omitted")
  const operation = yield* resolveOperation("books.create")
  const candidate = yield* makeCandidate(declaration, 11)
  expect(candidate.valid).toBe(true)
  expect(Object.hasOwn(candidate.input, "rating")).toBe(false)
  expect(candidate.omittedFields).toContain("rating")
  const decoded = yield* Schema.decodeUnknownEffect(operation.payloadSchema)(candidate.input)
  const encoded = yield* Schema.decodeUnknownEffect(PayloadSchema)(yield* Schema.encodeUnknownEffect(operation.payloadSchema)(decoded))
  expect(Object.hasOwn(encoded, "rating")).toBe(false)
  const replayed = yield* replayCandidate(declaration, candidate)
  expect(replayed.valid).toBe(true)
  expect(replayed.input).toEqual(candidate.input)
  expect(Object.hasOwn(replayed.input, "rating")).toBe(false)

  const { notes: _notes, ...withoutNullableFields } = candidate.input
  const omittedDecoded = yield* Schema.decodeUnknownEffect(operation.payloadSchema)(withoutNullableFields)
  const omittedEncoded = yield* Schema.decodeUnknownEffect(PayloadSchema)(yield* Schema.encodeUnknownEffect(operation.payloadSchema)(omittedDecoded))
  expect(Object.hasOwn(omittedEncoded, "rating")).toBe(false)
  expect(Object.hasOwn(omittedEncoded, "notes")).toBe(false)
}))

it.effect("update binds every unchanged field and identity to the complete fixture target", () => Effect.gen(function* () {
  const sampled = yield* sampleOperation("books.update", 18, 1)
  const target: Payload = {
    ...sampled[0]!.input,
    title: "A fixture title",
    author: "A fixture author",
    status: "reading",
    format: "hardcover",
    rating: null,
    notes: "Preserve this fixture note",
  }
  const operation = yield* resolveOperation("books.update")
  for (const strategy of ["sample", "maximum", "above", "omitted"] as const) {
    const candidate = yield* makeCandidate(scenario(strategy, "books.update"), 18, target)
    const { rating: _targetRating, ...unchangedTarget } = target
    const { rating: _candidateRating, ...unchangedCandidate } = candidate.input
    expect(unchangedCandidate).toEqual(unchangedTarget)
    expect(candidate.input.id).toBe(target.id)
    expect(candidate.valid).toBe(strategy === "sample" || strategy === "maximum")
    const decoded = yield* Schema.decodeUnknownEffect(operation.payloadSchema)(candidate.input).pipe(Effect.result)
    expect(decoded._tag).toBe(candidate.valid ? "Success" : "Failure")
  }
  expect(target.rating).toBe(null)
  const missing = yield* makeCandidate(scenario("maximum", "books.update"), 18).pipe(Effect.result)
  expect(missing._tag).toBe("Failure")
  if (missing._tag === "Failure") expect(missing.failure.boundary).toBe("inputs.fixture")
}))

it.effect("unresolved operations and unsupported strategy bindings fail explicitly", () => Effect.gen(function* () {
  const unknown = yield* resolveOperation("books.missing").pipe(Effect.result)
  expect(unknown._tag).toBe("Failure")
  if (unknown._tag === "Failure") expect(unknown.failure.boundary).toBe("inputs.operation")
  const unsupported = yield* sampleOperation("books.remove", 1, 1).pipe(Effect.result)
  expect(unsupported._tag).toBe("Failure")
  if (unsupported._tag === "Failure") expect(unsupported.failure.boundary).toBe("inputs.unsupported")
  const empty = yield* sampleOperation("books.create", 1, 0).pipe(Effect.result)
  expect(empty._tag).toBe("Failure")
  if (empty._tag === "Failure") expect(empty.failure.boundary).toBe("inputs.unsupported")
}))

it.effect("concrete update replay rebinds only identity and retains recorded values and provenance", () => Effect.gen(function* () {
  const targets = yield* sampleOperation("books.update", 62, 2)
  const originalTarget = targets[0]!.input
  const freshTarget = targets[1]!.input
  for (const strategy of ["maximum", "above"] as const) {
    const declaration = scenario(strategy, "books.update")
    const recorded = yield* makeCandidate(declaration, 63, originalTarget)
    const replayed = yield* replayCandidate(declaration, recorded, freshTarget)
    expect(replayed.input).toEqual({ ...recorded.input, id: freshTarget.id })
    expect(replayed.source).toBe(recorded.source)
    expect(replayed.seed).toBe(recorded.seed)
    expect(replayed.strategy).toBe(recorded.strategy)
    expect(replayed.valid).toBe(recorded.valid)
    const operation = yield* resolveOperation("books.update")
    const decoded = yield* Schema.decodeUnknownEffect(operation.payloadSchema)(replayed.input).pipe(Effect.result)
    expect(decoded._tag).toBe(replayed.valid ? "Success" : "Failure")
  }
}))

it.effect("create replay rejects forbidden identity and records with the wrong native validity", () => Effect.gen(function* () {
  const declaration = scenario("above")
  const recorded = yield* makeCandidate(declaration, 71)
  const replayed = yield* replayCandidate(declaration, recorded)
  expect(replayed.input).toEqual(recorded.input)
  const suppliedId = yield* replayCandidate(declaration, {
    ...recorded, input: { ...recorded.input, id: "forbidden" },
  }).pipe(Effect.result)
  expect(suppliedId._tag).toBe("Failure")
  const validRating = yield* replayCandidate(declaration, {
    ...recorded, input: { ...recorded.input, rating: null },
  }).pipe(Effect.result)
  expect(validRating._tag).toBe("Failure")
  const wrongField = yield* replayCandidate(declaration, {
    ...recorded, input: { ...recorded.input, title: "" },
  }).pipe(Effect.result)
  expect(wrongField._tag).toBe("Failure")
  const wrongMetadata = yield* replayCandidate(declaration, { ...recorded, valid: true }).pipe(Effect.result)
  expect(wrongMetadata._tag).toBe("Failure")
}))
