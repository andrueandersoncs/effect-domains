import { Array, type Context, Effect, Equal, Exit, Function, Layer, Match, Option, Order, Predicate, Record, Result, Schema, SchemaAST, Struct, pipe } from "effect"
import type { ApplicationIR } from "effect-domains/application"
import { FastCheck } from "effect/testing"
import { RpcSchema } from "effect/unstable/rpc"
import { type NativeOperation, nativeOperations } from "./catalog.ts"

import {
  AcceptanceError,
  Candidate,
  InputCandidates,
  PayloadSchema,
  PreparedFixture,
  Submission,
  TextFixture,
  ValiditySchema,
  type CapturedSource,
  type FieldSource,
  type FixtureSource,
  type InputCase,
  NativeSourceSchema,
  NativeStrategySchema,
  type Payload,
  type Scenario,
  type TextSource,
} from "./model.ts"

type NativeOperations = ReadonlyArray<NativeOperation>

type NativeCheck = SchemaAST.Checks[number]

type OrderedConstraint = Schema.Annotations.ToArbitrary.OrderedConstraint<unknown>

type BoundedStrategy = Exclude<typeof NativeStrategySchema.Type, "sample" | "null">

/** The runtime services a native wire codec may need because encoding and decoding must match the served application exactly. */
export type CodecServices = Context.Context<never>

/**
 * The whole-payload search is bounded and fixed because custom and correlated checks must report exhaustion reproducibly
 * instead of looping; opaque checks are enforced only by this loop, so it allows enough attempts for rejection-sampled leaves.
 */
const sampleAttempts = 200

/** Recursive samples are bounded by depth because a recursive schema admits arbitrarily deep values the generated form cannot usefully carry. */
const maximumDepth = 8

class NumericBounds extends Schema.Class<NumericBounds>("NumericBounds")({
  minimum: Schema.Int,
  maximum: Schema.Int,
}) {}

const SubmissionsSchema = Schema.Array(Submission)
const TextFixturesSchema = Schema.Array(TextFixture)

class Sources extends Schema.Class<Sources>("Sources")({
  fixture: PreparedFixture,
  submissions: SubmissionsSchema,
  textFixtures: TextFixturesSchema,
}) {}

class ResolvedField extends Schema.Class<ResolvedField>("ResolvedField")({
  field: Schema.String,
  value: Schema.Unknown,
  provenance: Schema.String,
}) {}

type FieldResolution = Effect.Effect<Option.Option<ResolvedField>, AcceptanceError>

const ResolvedFieldsSchema = Schema.Array(ResolvedField)

class Resolution extends Schema.Class<Resolution>("Resolution")({
  fields: ResolvedFieldsSchema,
}) {}

class Captured extends Schema.Class<Captured>("Captured")({
  submission: Submission,
  value: Schema.Unknown,
}) {}

class Validation extends Schema.Class<Validation>("Validation")({
  validity: ValiditySchema,
  input: PayloadSchema,
  nativeValidation: Schema.String,
}) {}

const parseOptions: SchemaAST.ParseOptions = { onExcessProperty: "error" }

const isPayload = Schema.is(PayloadSchema)

const describe = (cause: unknown) => Predicate.isError(cause) ? cause.message : String(cause)

const inputError = (boundary: string) => (message: string) => AcceptanceError.make({ boundary, message })

const fail = (boundary: string, message: string) => pipe(message, inputError(boundary), Effect.fail)

const messagePrefixed = (prefix: string) => (message: string) => `${prefix}${message}`

const causedBy = (boundary: string, prefix: string) => Effect.mapError(Function.flow(describe, messagePrefixed(prefix), inputError(boundary)))

const withTag = (name: string) => (request: NativeOperation): boolean => Equal.equals(request._tag, name)

const namedField = (name: string) => (field: SchemaAST.PropertySignature): boolean => Equal.equals(field.name, name)

const withId = (id: string) => (declaration: InputCase | TextFixture): boolean => Equal.equals(declaration.id, id)

const isUnencoded = (ast: SchemaAST.AST) => Predicate.isUndefined(ast.encoding)

const propertySignature = (name: string) => (ast: SchemaAST.AST) => pipe(
  ast,
  Option.liftPredicate(SchemaAST.isObjects),
  Option.map(Struct.get("propertySignatures")),
  Option.flatMap(Array.findFirst(namedField(name))),
)

const propertyType = (name: string) => Function.flow(propertySignature(name), Option.map(Struct.get("type")))

const fieldValue = (resolved: ResolvedField): readonly [string, unknown] => [resolved.field, resolved.value]

const payloadOf = (resolution: Resolution): Payload => pipe(resolution.fields, Array.map(fieldValue), Record.fromEntries)

const provenanceOf = (resolution: Resolution) => pipe(resolution.fields, Array.map(Struct.get("provenance")), Array.join("; "))

const toResolution = (fields: ReadonlyArray<ResolvedField>) => Resolution.make({ fields })

const present = (resolved: ResolvedField): FieldResolution => pipe(resolved, Option.some, Effect.succeed)

const resolveOperation = (operations: NativeOperations) => Effect.fn("Acceptance.resolveOperation")(function* (name: string) {
  const matches = Array.filter(operations, withTag(name))
  const unique = Equal.equals(matches.length, 1)
  const single = pipe(matches, Array.head, Option.filter(Function.constant(unique)))

  if (Option.isNone(single)) {
    return yield* fail("inputs.operation", `Expected exactly one native operation ${name}; found ${matches.length}`)
  }

  const streaming = RpcSchema.isStreamSchema(single.value.successSchema)

  if (streaming) {
    return yield* fail("inputs.unsupported", `Operation ${name} is not unary`)
  }

  return single.value
})

const offsetText = (offset: number) => Equal.equals(offset, 0) ? "" : ` offset ${offset}`

const shift = (offset: number) => (value: number) => value + offset

const withOffset = (boundary: string, where: string, offset: number) => (value: unknown) => {
  const unchanged = Equal.equals(offset, 0)
  const shifted = pipe(value, Option.liftPredicate(Predicate.isNumber), Option.map(shift(offset)))
  const nonNumeric = fail(boundary, `${where} offset ${offset} requires a numeric value`)
  const applied = Option.match(shifted, { onNone: Function.constant(nonNumeric), onSome: Effect.succeed })

  return unchanged ? Effect.succeed(value) : applied
}

const fixtureField = (sources: Sources, field: string) => Effect.fn("Acceptance.fixtureField")(function* (source: FixtureSource) {
  const fact = Record.get(sources.fixture.facts, source.fact)
  const prepared = `${sources.fixture.binding}@${sources.fixture.revision}`
  const where = `Fixture fact ${source.fact} for ${field}`

  if (Option.isNone(fact)) {
    return yield* fail("inputs.fixture", `${where} is not prepared by ${prepared}`)
  }

  const value = yield* withOffset("inputs.fixture", where, source.offset)(fact.value)
  const provenance = `${field} ← fixture ${prepared} fact ${source.fact}${offsetText(source.offset)}`
  const resolved = ResolvedField.make({ field, value, provenance })

  return Option.some(resolved)
})

const isSuccessful = (submission: Submission) => {
  const reached = submission.status >= 200

  return reached && submission.status < 300
}

const captureOf = (submission: Submission) => (value: unknown) => Captured.make({ submission, value })

const capturedFrom = (name: string) => (submission: Submission) => {
  const successful = isSuccessful(submission)

  const value = pipe(
    submission.result,
    Option.filter(isPayload),
    Option.flatMap(Record.get(name)),
    Option.filter(Function.constant(successful)),
  )

  return Option.map(value, captureOf(submission))
}

// An unresolvable capture is not an error because the producing submission may simply not have happened yet.
const capturedField = (sources: Sources, field: string) => Effect.fn("Acceptance.capturedField")(function* (source: CapturedSource) {
  const latest = Array.findLast(sources.submissions, capturedFrom(source.field))

  if (Option.isNone(latest)) {
    return Option.none<ResolvedField>()
  }

  const { submission } = latest.value
  const value = yield* withOffset("inputs.captured", `Captured ${source.field} for ${field}`, source.offset)(latest.value.value)
  const origin = `${submission.operation} result of ${submission.inputCase} at ${submission.at}`
  const provenance = `${field} ← captured ${source.field} from ${origin}${offsetText(source.offset)}`
  const resolved = ResolvedField.make({ field, value, provenance })

  return Option.some(resolved)
})

const textField = (sources: Sources, field: string) => Effect.fn("Acceptance.textField")(function* (source: TextSource) {
  const fixture = Array.findFirst(sources.textFixtures, withId(source.fixture))
  const value = pipe(fixture, Option.map(Struct.get("values")), Option.flatMap(Record.get(source.field)))

  if (Option.isNone(fixture)) {
    return yield* fail("inputs.fixture", `Unavailable text fixture ${source.fixture} for ${field}`)
  }

  if (Option.isNone(value)) {
    return yield* fail("inputs.fixture", `Text fixture ${source.fixture} has no value ${source.field} for ${field}`)
  }

  const provenance = `${field} ← text ${fixture.value.id}@${fixture.value.revision}.${source.field} (${fixture.value.provenance})`
  const resolved = ResolvedField.make({ field, value: value.value, provenance })

  return Option.some(resolved)
})

const literalField = (field: string) => (source: Extract<FieldSource, { readonly source: "literal" }>): FieldResolution =>
  pipe(ResolvedField.make({ field, value: source.value, provenance: `${field} ← declared literal` }), present)

const isNativeSource = Schema.is(NativeSourceSchema)

const isSampled = (source: FieldSource) => isNativeSource(source) && Equal.equals(source.strategy, "sample")

/** Optional Never members are generated or trusted fields because the contract forbids callers to supply them. */
export const isOptionalNever = (signature: SchemaAST.PropertySignature) => {
  const never = SchemaAST.isNever(signature.type)

  return never && SchemaAST.isOptional(signature.type)
}

const callerSignature = (signature: SchemaAST.PropertySignature) => {
  const type = callerAst(signature.type)

  return new SchemaAST.PropertySignature(signature.name, type)
}

const groupBounded = (group: SchemaAST.FilterGroup<unknown>) => Array.every(group.checks, isBoundedCheck)

// A check is bounded for generation when it, or every check it groups, carries an arbitrary constraint because fast-check then derives satisfying values instead of rejecting without limit.
const isBoundedCheck = (check: NativeCheck): boolean => {
  const annotated = Predicate.isNotUndefined(check.annotations?.arbitrary)
  const grouped = pipe(Match.value(check), Match.tag("FilterGroup", groupBounded), Match.orElse(Function.constFalse))

  return annotated || grouped
}

// Opaque checks are left to the bounded merge-and-decode loop because fast-check would retry an unsatisfiable predicate forever.
const boundedChecks = (ast: SchemaAST.AST) => pipe(
  ast.checks,
  Option.fromNullishOr,
  Option.map(Array.filter(isBoundedCheck)),
  Option.filter(Array.isReadonlyArrayNonEmpty<NativeCheck>),
)

const hasOpaqueChecks = (ast: SchemaAST.AST) => pipe(ast.checks, Option.fromNullishOr, Option.exists(Array.some(Predicate.not(isBoundedCheck))))

const callerObjects = (ast: SchemaAST.Objects): SchemaAST.AST => {
  const signatures = pipe(ast.propertySignatures, Array.filter(Predicate.not(isOptionalNever)), Array.map(callerSignature))
  const checks = pipe(ast, boundedChecks, Option.getOrUndefined)

  return new SchemaAST.Objects(signatures, ast.indexSignatures, ast.annotations, checks, undefined, ast.context)
}

const callerArrays = (ast: SchemaAST.Arrays): SchemaAST.AST => {
  const elements = Array.map(ast.elements, callerAst)
  const rest = Array.map(ast.rest, callerAst)
  const checks = pipe(ast, boundedChecks, Option.getOrUndefined)

  return new SchemaAST.Arrays(ast.isMutable, elements, rest, ast.annotations, checks, undefined, ast.context)
}

const callerUnion = (ast: SchemaAST.Union): SchemaAST.AST => {
  const types = Array.map(ast.types, callerAst)
  const checks = pipe(ast, boundedChecks, Option.getOrUndefined)

  return new SchemaAST.Union(types, ast.mode, ast.annotations, checks, undefined, ast.context)
}

const callerNumber = (ast: SchemaAST.Number): SchemaAST.AST => {
  const checks = pipe(ast, boundedChecks, Option.getOrUndefined)

  return new SchemaAST.Number(ast.annotations, checks, undefined, ast.context)
}

const callerString = (ast: SchemaAST.String): SchemaAST.AST => {
  const checks = pipe(ast, boundedChecks, Option.getOrUndefined)

  return new SchemaAST.String(ast.annotations, checks, undefined, ast.context)
}

const callerContainer = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (SchemaAST.isObjects(ast)) return callerObjects(ast)

  if (SchemaAST.isArrays(ast)) return callerArrays(ast)

  return SchemaAST.isUnion(ast) ? callerUnion(ast) : ast
}

/** Rebuilds the decoded caller type without generated or trusted members and without opaque checks because only the bounded loop may enforce what fast-check cannot derive. */
const callerAst = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (SchemaAST.isNumber(ast)) return callerNumber(ast)

  return SchemaAST.isString(ast) ? callerString(ast) : callerContainer(ast)
}

const childTypes = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> => {
  if (SchemaAST.isObjects(ast)) return Array.map(ast.propertySignatures, Struct.get("type"))

  if (SchemaAST.isArrays(ast)) return Array.appendAll(ast.elements, ast.rest)

  return SchemaAST.isUnion(ast) ? ast.types : Array.empty<SchemaAST.AST>()
}

// Suspended members are not entered because a recursive schema would make the walk itself unbounded.
const hasOpaqueRemainder = (ast: SchemaAST.AST): boolean => {
  const own = hasOpaqueChecks(ast)
  const nested = pipe(ast, childTypes, Array.some(hasOpaqueRemainder))

  return own || nested
}

const deriveArbitrary = (ast: SchemaAST.AST) => {
  const arbitrary = pipe(ast, Schema.make, Schema.toArbitrary)

  return arbitrary(FastCheck)
}

const unsampleable = (operation: NativeOperation) =>
  Result.fail(`Native ${operation._tag} payload has a custom check without an arbitrary constraint on a member other than a string, number, object, array, or union, so it cannot be sampled with bounded effort; declare a literal or fixture source`)

const arbitraryOf = (operation: NativeOperation) => (caller: SchemaAST.AST) => Result.try({
  try: () => deriveArbitrary(caller),
  catch: Function.flow(describe, messagePrefixed(`Native ${operation._tag} whole-payload arbitrary: `)),
})

// The decoded caller type drives generation because Schema.toArbitrary produces decoded values; the wire value comes from the payload codec.
const payloadArbitraryOf = (operation: NativeOperation): Result.Result<FastCheck.Arbitrary<unknown>, string> => {
  const caller = pipe(operation.payloadSchema.ast, SchemaAST.toType, callerAst)
  const opaque = hasOpaqueRemainder(caller)

  return opaque ? unsampleable(operation) : arbitraryOf(operation)(caller)
}

const payloadArbitrary = (operation: NativeOperation) => pipe(operation, payloadArbitraryOf, Effect.fromResult, Effect.mapError(inputError("inputs.unsupported")))

const sampleMany = (arbitrary: FastCheck.Arbitrary<unknown>, seed: number) => FastCheck.sample(arbitrary, { seed, numRuns: sampleAttempts })

const nestedValues = (value: unknown): ReadonlyArray<unknown> => {
  if (Array.isArray(value)) return value

  return isPayload(value) ? Record.values(value) : Array.empty<unknown>()
}

const depthOf = (value: unknown): number => {
  const children = nestedValues(value)
  const deepest = pipe(children, Array.map(depthOf), Array.reduce(0, Order.max(Order.Number)))

  return Array.isReadonlyArrayEmpty(children) ? 0 : deepest + 1
}

class SampledPayload extends Schema.Class<SampledPayload>("SampledPayload")({
  attempt: Schema.Int,
  values: PayloadSchema,
}) {}

type Attempt = Result.Result<SampledPayload, string>

const nativeDecoder = (operation: NativeOperation, services: CodecServices) => (payload: unknown) =>
  pipe(payload, Schema.decodeUnknownEffect(payloadCodec(operation), parseOptions), Effect.provideContext(services))

const nativeEncoder = (operation: NativeOperation, services: CodecServices) => (decoded: unknown) =>
  pipe(decoded, Schema.encodeUnknownEffect(payloadCodec(operation), parseOptions), Effect.provideContext(services))

const declaredIn = (encoded: Payload) => (field: string) => Record.has(encoded, field)

const pickFields = (encoded: Payload, fields: ReadonlyArray<string>) => {
  const picked = (_value: unknown, field: string) => Array.contains(fields, field)

  return Record.filter(encoded, picked)
}

const unsatisfied = (error: Schema.SchemaError) => {
  const reason = describe(error)

  return Result.fail(`merged with the declared values it violates a native check: ${reason}`)
}

// A native-invalid case keeps its first encodable sample because its declared values, not the sample, carry the violation the browser must submit.
const attemptSample = (operation: NativeOperation, services: CodecServices, fields: ReadonlyArray<string>, fixed: Payload, validity: InputCase["validity"]) =>
  Effect.fn("Acceptance.attemptSample")(function* (sample: unknown, index: number): Effect.fn.Return<Attempt> {
    const depth = depthOf(sample)
    const deep = depth > maximumDepth

    if (deep) return Result.fail(`sample depth ${depth} exceeds the bound ${maximumDepth}`)

    const encoded = yield* pipe(sample, nativeEncoder(operation, services), Effect.flatMap(Schema.decodeUnknownEffect(PayloadSchema)), Effect.result)

    if (Result.isFailure(encoded)) {
      const reason = describe(encoded.failure)

      return Result.fail(`the sample does not encode to an object payload: ${reason}`)
    }

    const complete = Array.every(fields, declaredIn(encoded.success))

    if (!complete) return Result.fail("the sample omits a declared optional field")

    const values = pickFields(encoded.success, fields)
    const sampled = SampledPayload.make({ attempt: index + 1, values })
    const accepted = Result.succeed(sampled)
    const merged = Record.union(fixed, values, Function.identity)
    const invalid = Equal.equals(validity, "native-invalid")

    if (invalid) return accepted

    const decoded = yield* pipe(merged, nativeDecoder(operation, services), Effect.result)

    return Result.match(decoded, { onFailure: unsatisfied, onSuccess: Function.constant(accepted) })
  })

const lastProblem = (attempts: ReadonlyArray<Attempt>) => pipe(attempts, Array.getFailures, Array.last, Option.getOrElse(Function.constant("no sample was drawn")))

const sampledField = (operation: NativeOperation, seed: number, sampled: SampledPayload) => ([field, value]: readonly [string, unknown]) => {
  const provenance = `${field} ← native whole-payload sample of ${operation._tag} (seed ${seed}, attempt ${sampled.attempt} of ${sampleAttempts}, generated/trusted members excluded)`

  return ResolvedField.make({ field, value, provenance })
}

/**
 * Samples every `native sample` field from one decoded value of the whole caller payload because struct-level and
 * correlated checks constrain fields together; the declared values are merged and the bounded search reports exhaustion.
 */
const sampleWhole = (operation: NativeOperation, services: CodecServices, validity: InputCase["validity"], seed: number) =>
  Effect.fn("Acceptance.sampleWhole")(function* (fields: ReadonlyArray<string>, resolution: Resolution) {
    const none = Array.isReadonlyArrayEmpty(fields)

    if (none) return resolution

    const arbitrary = yield* payloadArbitrary(operation)

    const samples = yield* Effect.try({
      try: () => sampleMany(arbitrary, seed),
      catch: Function.flow(describe, messagePrefixed(`Native ${operation._tag} sample: `), inputError("inputs.unsupported")),
    })

    const fixed = payloadOf(resolution)
    const attempts = yield* Effect.forEach(samples, attemptSample(operation, services, fields, fixed, validity))
    const chosen = pipe(attempts, Array.getSuccesses, Array.head)
    const declared = Array.join(fields, ", ")
    const problem = lastProblem(attempts)

    if (Option.isNone(chosen)) {
      return yield* fail("inputs.exhausted", `No whole-payload native sample of ${operation._tag} among ${sampleAttempts} seeded attempts (seed ${seed}) yields ${declared} satisfying every native check with the declared values; last attempt: ${problem}`)
    }

    const entries = Record.toEntries(chosen.value.values)
    const sampledFields = Array.map(entries, sampledField(operation, seed, chosen.value))

    return pipe(resolution.fields, Array.appendAll(sampledFields), toResolution)
  })

// The payload codec is rebuilt from its AST because the erased operation type cannot state its codec services; callers provide them.
export const payloadCodec = (operation: NativeOperation) => Schema.make<Schema.Codec<unknown, unknown>>(operation.payloadSchema.ast)

const fieldCodec = (operation: NativeOperation, field: string) => pipe(operation.payloadSchema.ast, Option.liftPredicate(isUnencoded), Option.flatMap(propertyType(field)))

const isUnrefined = (ast: SchemaAST.AST) => {
  const unencoded = isUnencoded(ast)

  return unencoded && Predicate.isUndefined(ast.checks)
}

const isNullablePair = (ast: SchemaAST.Union) => {
  const pair = Equal.equals(ast.types.length, 2)

  return pair && Array.some(ast.types, SchemaAST.isNull)
}

const nullableUnion = (ast: SchemaAST.AST) => pipe(
  ast,
  Option.liftPredicate(SchemaAST.isUnion),
  Option.filter(isUnrefined),
  Option.filter(isNullablePair),
)

const unionNumber = (union: SchemaAST.Union) => Array.findFirst(union.types, SchemaAST.isNumber)

// A nullable field contributes its number branch because the bounds live on that branch, not on the union.
const nullableNumber = (ast: SchemaAST.AST) => pipe(ast, nullableUnion, Option.flatMap(unionNumber))

const numberBranch = (ast: SchemaAST.AST) => {
  const nullable = nullableNumber(ast)

  return pipe(
    ast,
    Option.liftPredicate(SchemaAST.isNumber),
    Option.orElse(Function.constant(nullable)),
    Option.filter(isUnencoded),
  )
}

const flattenChecks = (checks: Option.Option<SchemaAST.Checks>): ReadonlyArray<NativeCheck> => Option.match(checks, {
  onNone: Array.empty,
  onSome: Array.flatMap(withNestedChecks),
})

const nestedChecks = (filters: SchemaAST.FilterGroup<unknown>): ReadonlyArray<NativeCheck> => pipe(
  filters.checks,
  Option.some,
  flattenChecks,
  Array.prepend<NativeCheck>(filters),
)

const withNestedChecks = (check: NativeCheck): ReadonlyArray<NativeCheck> => pipe(
  Match.value(check),
  Match.tag("FilterGroup", nestedChecks),
  Match.orElse(Array.of<NativeCheck>),
)

const constraintOf = (check: NativeCheck) => Option.fromNullishOr(check.annotations?.arbitrary?.constraint)

const isIntegerCheck = (check: NativeCheck) => pipe(
  constraintOf(check),
  Option.exists(Function.flow(Struct.get("integer"), Equal.equals(true))),
)

const usesNumberOrder = (ordered: OrderedConstraint) => Equal.equals(ordered.order, Order.Number)

const orderedOf = (check: NativeCheck): Option.Option<OrderedConstraint> => pipe(
  constraintOf(check),
  Option.flatMapNullishOr(Struct.get("ordered")),
  Option.filter(usesNumberOrder),
)

const inclusiveBound = (bound: Option.Option<unknown>, exclusive: boolean, message: string): Result.Result<Option.Option<number>, string> => {
  const numeric = Option.filter(bound, Predicate.isNumber)
  const rejected = exclusive ? bound : Option.filter(bound, Predicate.not(Predicate.isNumber))

  return Option.isSome(rejected) ? Result.fail(message) : Result.succeed(numeric)
}

const lowerBound = (field: string) => (ordered: OrderedConstraint) => {
  const bound = Option.fromNullishOr(ordered.minimum)
  const exclusive = Equal.equals(ordered.exclusiveMinimum, true)

  return inclusiveBound(bound, exclusive, `Native strategies on ${field} require inclusive numeric lower constraints`)
}

const upperBound = (field: string) => (ordered: OrderedConstraint) => {
  const bound = Option.fromNullishOr(ordered.maximum)
  const exclusive = Equal.equals(ordered.exclusiveMaximum, true)

  return inclusiveBound(bound, exclusive, `Native strategies on ${field} require inclusive numeric upper constraints`)
}

const orderedBounds = (field: string) => (constraint: OrderedConstraint) => {
  const lower = lowerBound(field)(constraint)
  const upper = upperBound(field)(constraint)

  return Result.all([lower, upper])
}

// The bounds are constructed only once they are known to be finite integers because the bounds schema rejects anything else.
const boundsUpTo = (maximum: number) => (minimum: number) => NumericBounds.make({ minimum, maximum })

const boundsWithin = (operation: NativeOperation, field: string, checks: ReadonlyArray<NativeCheck>) => (bounds: ReadonlyArray<readonly [Option.Option<number>, Option.Option<number>]>) => {
  const minimum = pipe(bounds, Array.map(Struct.get(0)), Array.getSomes, Array.reduce(-Infinity, Order.max(Order.Number)))
  const maximum = pipe(bounds, Array.map(Struct.get(1)), Array.getSomes, Array.reduce(Infinity, Order.min(Order.Number)))
  const integer = Array.some(checks, isIntegerCheck)
  const finite = Array.every([minimum, maximum], Number.isSafeInteger)
  const distinct = minimum < maximum
  const supported = Array.every([integer, finite, distinct], Function.identity)
  const unsupported = Result.fail(`Native bound strategies on ${operation._tag}.${field} require native integer checks and distinct finite inclusive bounds`)
  const checked = supported ? Result.succeed(minimum) : unsupported

  return Result.map(checked, boundsUpTo(maximum))
}

const numberBounds = (operation: NativeOperation, field: string) => (numeric: SchemaAST.Number) => {
  const checks = pipe(numeric.checks, Option.fromNullishOr, flattenChecks)

  return pipe(checks, Array.map(orderedOf), Array.getSomes, Array.map(orderedBounds(field)), Result.all, Result.flatMap(boundsWithin(operation, field, checks)))
}

const numericBoundsOf = (operation: NativeOperation, field: string): Result.Result<NumericBounds, string> => {
  const numeric = pipe(fieldCodec(operation, field), Option.flatMap(numberBranch))
  const unsupported = Result.fail(`Native bound strategies need ${operation._tag}.${field} to be an untransformed number or nullable number`)

  return Option.match(numeric, { onNone: Function.constant(unsupported), onSome: numberBounds(operation, field) })
}

const numericBounds = (operation: NativeOperation, field: string) => pipe(numericBoundsOf(operation, field), Effect.fromResult, Effect.mapError(inputError("inputs.unsupported")))

const belowMinimum = (bounds: NumericBounds) => bounds.minimum - 1

const aboveMaximum = (bounds: NumericBounds) => bounds.maximum + 1

const fractionalMinimum = (bounds: NumericBounds) => bounds.minimum + 0.5

const boundPick = (strategy: BoundedStrategy): (bounds: NumericBounds) => number => pipe(
  Match.value(strategy),
  Match.when("minimum", Function.constant(Struct.get<NumericBounds, "minimum">("minimum"))),
  Match.when("maximum", Function.constant(Struct.get<NumericBounds, "maximum">("maximum"))),
  Match.when("below", Function.constant(belowMinimum)),
  Match.when("above", Function.constant(aboveMaximum)),
  Match.when("fractional", Function.constant(fractionalMinimum)),
  Match.exhaustive,
)

// The bound value is the wire value because the number branch carries no encoding.
const boundedValue = (operation: NativeOperation, field: string) => Effect.fn("Acceptance.boundedValue")(function* (strategy: BoundedStrategy) {
  const bounds = yield* numericBounds(operation, field)
  const value = boundPick(strategy)(bounds)
  const provenance = `${field} ← native ${strategy} of ${operation._tag}.${field} bounds ${bounds.minimum}..${bounds.maximum}`
  const resolved = ResolvedField.make({ field, value, provenance })

  return Option.some(resolved)
})

const nullableOf = (operation: NativeOperation, field: string) => () => {
  const nullable = pipe(fieldCodec(operation, field), Option.flatMap(nullableUnion))
  const message = `Native null strategy needs ${operation._tag}.${field} to be an untransformed nullable field`

  return Result.fromOption(nullable, Function.constant(message))
}

const nullValue = (operation: NativeOperation, field: string) => Effect.fn("Acceptance.nullValue")(function* () {
  yield* pipe(nullableOf(operation, field)(), Effect.fromResult, Effect.mapError(inputError("inputs.unsupported")))

  const provenance = `${field} ← native null of nullable ${operation._tag}.${field}`
  const resolved = ResolvedField.make({ field, value: null, provenance })

  return Option.some(resolved)
})

const jointSample = (operation: NativeOperation, field: string) =>
  fail("inputs.unsupported", `Native sample of ${operation._tag}.${field} is drawn with the whole payload, never field by field`)

const nativeField = (operation: NativeOperation, field: string) => (source: typeof NativeSourceSchema.Type): FieldResolution => {
  const joint = jointSample(operation, field)

  return pipe(
    Match.value(source.strategy),
    Match.when("sample", Function.constant(joint)),
    Match.when("null", nullValue(operation, field)),
    Match.orElse(boundedValue(operation, field)),
  )
}

const callerSignatureOf = (operation: NativeOperation, field: string) => pipe(operation.payloadSchema.ast, SchemaAST.toType, propertySignature(field))

// A sampled member must be one the caller supplies because the whole-payload arbitrary omits generated and trusted members, so their samples always exhaust.
const samplingOf = (operation: NativeOperation, field: string) => (): Result.Result<unknown, string> => {
  const supplied = pipe(callerSignatureOf(operation, field), Option.exists(Predicate.not(isOptionalNever)))
  const generated = Result.fail(`Native sample of ${operation._tag}.${field} needs a caller-supplied payload member; generated and trusted members are never sampled`)

  return supplied ? payloadArbitraryOf(operation) : generated
}

const boundsOf = (operation: NativeOperation, field: string) => () => numericBoundsOf(operation, field)

/**
 * Why the interpreter cannot apply a native strategy to a payload field, if it cannot, because declaration validation must reject an
 * unsupported requested interpretation with exactly the reason the interpreter would fail it at run time.
 */
export const nativeStrategyProblem = (operation: NativeOperation, field: string) => (strategy: typeof NativeStrategySchema.Type): Option.Option<string> => pipe(
  Match.value(strategy),
  Match.when("sample", samplingOf(operation, field)),
  Match.when("null", nullableOf(operation, field)),
  Match.orElse(boundsOf(operation, field)),
  Result.getFailure,
)

/** Whether the interpreter can apply a native strategy to a payload field because coverage reports may list only strategies a scenario could declare. */
export const nativeStrategyApplies = (operation: NativeOperation, field: string) => Function.flow(nativeStrategyProblem(operation, field), Option.isNone)

const failureReason = (failure: Option.Option<Schema.SchemaError>) => Option.match(failure, { onNone: Function.constant("the field codec failed without a schema issue"), onSome: describe })

const fieldDecoding = (value: unknown) => (ast: SchemaAST.AST): Option.Option<string> => {
  const fieldSchema = Schema.make<Schema.Codec<unknown, unknown>>(ast)
  const decoded = Schema.decodeUnknownExit(fieldSchema)(value)
  const reason = pipe(decoded, Exit.findErrorOption, failureReason)

  return Exit.isFailure(decoded) ? Option.some(reason) : Option.none()
}

const decodedPropertyType = (field: string) => (ast: SchemaAST.AST) => () => pipe(ast, SchemaAST.toType, propertyType(field))

// The authored property codec decodes the wire literal when the payload is an object schema, because that codec is what the payload decode applies to the field; otherwise the decoded type is read.
const literalFieldAst = (operation: NativeOperation, field: string) => {
  const { ast } = operation.payloadSchema

  return pipe(ast, propertyType(field), Option.orElse(decodedPropertyType(field)(ast)))
}

/** Why a declared literal is not a value of the native payload field, if it is not, because a native-valid case must submit values the field schema decodes. */
export const literalProblem = (operation: NativeOperation, field: string) => (value: unknown): Option.Option<string> =>
  pipe(literalFieldAst(operation, field), Option.flatMap(fieldDecoding(value)))

const resolveSource = (operation: NativeOperation, sources: Sources, field: string): (source: FieldSource) => FieldResolution => pipe(
  Match.type<FieldSource>(),
  Match.discriminatorsExhaustive("source")({
    fixture: fixtureField(sources, field),
    captured: capturedField(sources, field),
    text: textField(sources, field),
    literal: literalField(field),
    native: nativeField(operation, field),
  }),
)

const resolveField = (operation: NativeOperation, sources: Sources) => (source: FieldSource, field: string) =>
  resolveSource(operation, sources, field)(source)

const resolveFields = Effect.fn("Acceptance.resolveFields")(function* (
  fields: InputCase["fields"],
  resolver: (source: FieldSource, field: string) => FieldResolution,
) {
  const resolutions = Record.map(fields, resolver)
  const resolved = yield* Effect.all(resolutions)

  return pipe(resolved, Record.values, Option.all, Option.map(toResolution))
})

const nativeEncode = Effect.fn("Acceptance.nativeEncode")(function* (operation: NativeOperation, services: CodecServices, decoded: unknown) {
  const encoded = yield* pipe(
    decoded,
    nativeEncoder(operation, services),
    causedBy("inputs.native-encode", `Native ${operation._tag} payload does not encode: `),
  )

  return yield* pipe(
    encoded,
    Schema.decodeUnknownEffect(PayloadSchema),
    causedBy("inputs.unsupported", `Native ${operation._tag} encoding is not an object payload: `),
  )
})

// A rejected payload stays un-encoded because encoding would hide the rejection the browser must submit.
const validate = Effect.fn("Acceptance.validate")(function* (operation: NativeOperation, services: CodecServices, resolution: Resolution, phase: string) {
  const payload = payloadOf(resolution)
  const decoded = yield* pipe(payload, nativeDecoder(operation, services), Effect.result)

  if (Result.isFailure(decoded)) {
    const reason = describe(decoded.failure)

    return Validation.make({
      validity: "native-invalid",
      input: payload,
      nativeValidation: `rejected by the exact native ${operation._tag} codec${phase}: ${reason}`,
    })
  }

  const input = yield* nativeEncode(operation, services, decoded.success)

  return Validation.make({
    validity: "native-valid",
    input,
    nativeValidation: `accepted by the exact native ${operation._tag} codec${phase}; the candidate is the re-encoded value`,
  })
})

const resolveCase = (operations: NativeOperations, services: CodecServices, sources: Sources, seed: number) => Effect.fn("Acceptance.resolveCase")(function* (input: InputCase, index: number) {
  const operation = yield* resolveOperation(operations)(input.operation)
  const caseSeed = seed + index
  const fixedFields = Record.filter(input.fields, Predicate.not(isSampled))
  const sampledFields = pipe(input.fields, Record.filter(isSampled), Record.keys)
  const fixed = yield* resolveFields(fixedFields, resolveField(operation, sources))

  if (Option.isNone(fixed)) {
    return Option.none<Candidate>()
  }

  const resolution = yield* sampleWhole(operation, services, input.validity, caseSeed)(sampledFields, fixed.value)
  const validation = yield* validate(operation, services, resolution, "")
  const agrees = Equal.equals(validation.validity, input.validity)

  if (!agrees) {
    return yield* fail("inputs.validity", `Input ${input.id} is declared ${input.validity} but its payload is ${validation.validity}: ${validation.nativeValidation}`)
  }

  const candidate = Candidate.make({
    inputCase: input.id,
    operation: input.operation,
    description: input.description,
    input: validation.input,
    sources: input.fields,
    validity: validation.validity,
    nativeValidation: validation.nativeValidation,
    provenance: provenanceOf(resolution),
    seed: caseSeed,
  })

  return Option.some(candidate)
})

const resolve = (operations: NativeOperations, services: CodecServices) => Effect.fn("Acceptance.resolveCandidates")(function* (
  scenario: Scenario,
  fixture: PreparedFixture,
  submissions: ReadonlyArray<Submission>,
  textFixtures: ReadonlyArray<TextFixture>,
  seed: number,
) {
  const integral = Number.isSafeInteger(seed)

  if (!integral) {
    return yield* fail("inputs.unsupported", `Candidate resolution requires an integer seed; received ${seed}`)
  }

  const sources = Sources.make({ fixture, submissions, textFixtures })
  const candidates = yield* Effect.forEach(scenario.inputs, resolveCase(operations, services, sources, seed))

  return Array.getSomes(candidates)
})

const recordedValue = (field: string, provenance: string) => (value: unknown) =>
  pipe(ResolvedField.make({ field, value, provenance }), present)

const recordedField = (recorded: Candidate, field: string, provenance: string): FieldResolution => {
  const value = Record.get(recorded.input, field)
  const missing = fail("inputs.replay", `Recorded candidate ${recorded.inputCase} has no concrete ${field}`)

  return Option.match(value, { onNone: Function.constant(missing), onSome: recordedValue(field, provenance) })
}

const recordedNative = (recorded: Candidate, field: string) => () =>
  recordedField(recorded, field, `${field} ← recorded native sample (seed ${recorded.seed})`)

const asReplayError = (error: AcceptanceError) => AcceptanceError.make({ boundary: "inputs.replay", message: error.message })

// A text source the replay cannot re-derive is a replay disagreement because the recorded value can no longer be tied to its declaration.
const replayedText = (sources: Sources, field: string) => (source: TextSource): FieldResolution =>
  pipe(source, textField(sources, field), Effect.mapError(asReplayError))

// Native values are replayed concretely because the recorded sample is the evidence; every declared value comes from the fresh run and is compared afterwards.
const replayField = (operation: NativeOperation, sources: Sources, recorded: Candidate) => (source: FieldSource, field: string): FieldResolution => pipe(
  Match.value(source),
  Match.discriminators("source")({
    native: recordedNative(recorded, field),
    text: replayedText(sources, field),
  }),
  Match.orElse(resolveSource(operation, sources, field)),
)

const isDeclaredValue = (source: FieldSource) => {
  const literal = Equal.equals(source.source, "literal")

  return literal || Equal.equals(source.source, "text")
}

const declaredValueFields = (fields: InputCase["fields"]) => pipe(fields, Record.filter(isDeclaredValue), Record.keys)

const sameField = (left: Payload, right: Payload) => (field: string) => {
  const leftValue = Record.get(left, field)
  const rightValue = Record.get(right, field)

  return Equal.equals(leftValue, rightValue)
}

const replayCandidate = (operations: NativeOperations, services: CodecServices, scenario: Scenario, sources: Sources) => Effect.fn("Acceptance.replayCandidate")(function* (recorded: Candidate) {
  const declared = Array.findFirst(scenario.inputs, withId(recorded.inputCase))

  if (Option.isNone(declared)) {
    return yield* fail("inputs.replay", `Recorded candidate ${recorded.inputCase} is not declared by ${scenario.id}`)
  }

  const sameOperation = Equal.equals(recorded.operation, declared.value.operation)
  const sameSources = Equal.equals(recorded.sources, declared.value.fields)
  const sameValidity = Equal.equals(recorded.validity, declared.value.validity)
  const agrees = Array.every([sameOperation, sameSources, sameValidity], Function.identity)

  if (!agrees) {
    return yield* fail("inputs.replay", `Recorded candidate ${recorded.inputCase} disagrees with its declared operation, field sources, or validity`)
  }

  const operation = yield* resolveOperation(operations)(declared.value.operation)
  const resolution = yield* resolveFields(declared.value.fields, replayField(operation, sources, recorded))

  if (Option.isNone(resolution)) {
    return Option.none<Candidate>()
  }

  const validation = yield* validate(operation, services, resolution.value, " during concrete-input replay")
  const validityHolds = Equal.equals(validation.validity, recorded.validity)

  if (!validityHolds) {
    return yield* fail("inputs.replay", `Replayed ${recorded.inputCase} is ${validation.validity} but was recorded ${recorded.validity}: ${validation.nativeValidation}`)
  }

  const declaredValuesHold = pipe(declared.value.fields, declaredValueFields, Array.every(sameField(validation.input, recorded.input)))

  if (!declaredValuesHold) {
    return yield* fail("inputs.replay", `Recorded candidate ${recorded.inputCase} carries a literal or text value other than its declared source`)
  }

  const candidate = Candidate.make({
    inputCase: recorded.inputCase,
    operation: recorded.operation,
    description: declared.value.description,
    input: validation.input,
    sources: declared.value.fields,
    validity: validation.validity,
    nativeValidation: validation.nativeValidation,
    provenance: provenanceOf(resolution.value),
    seed: recorded.seed,
  })

  return Option.some(candidate)
})

const replay = (operations: NativeOperations, services: CodecServices) => Effect.fn("Acceptance.replayCandidates")(function* (
  scenario: Scenario,
  recorded: ReadonlyArray<Candidate>,
  fixture: PreparedFixture,
  submissions: ReadonlyArray<Submission>,
  textFixtures: ReadonlyArray<TextFixture>,
) {
  const sources = Sources.make({ fixture, submissions, textFixtures })
  const candidates = yield* Effect.forEach(recorded, replayCandidate(operations, services, scenario, sources))

  return Array.getSomes(candidates)
})

/** Codec services are runtime-provided because a native wire codec may need them to encode and decode exactly as the served application does. */
export const inputLayer = (application: ApplicationIR, services: CodecServices): Layer.Layer<InputCandidates> => {
  const operations = nativeOperations(application)

  return Layer.succeed(InputCandidates, { resolve: resolve(operations, services), replay: replay(operations, services) })
}
