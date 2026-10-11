import { Array, Context, Effect, Equal, Function, HashMap, Layer, Match, Number, Option, Order, Predicate, Record, Result, Schema, SchemaAST, Struct, String as Text, flow, pipe } from "effect"
import { Application, type ApplicationIR, Part } from "effect-domains/application"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { type NativeOperation, amongst, nativeOperations } from "./catalog.ts"
import { type CodecServices, isOptionalNever, payloadCodec } from "./inputs.ts"

import {
  AcceptanceError,
  BoundRequirement,
  Candidate,
  EvaluationContext,
  InputCase,
  LiteralSourceSchema,
  Observation,
  PayloadSchema,
  PreparedFixture,
  ProbeRecord,
  RequirementEvaluation,
  RequirementResult,
  ResultStatusSchema,
  Scenario,
  Submission,
  type Payload,
} from "./model.ts"

type Status = typeof ResultStatusSchema.Type

/** One criterion's verdict for one required input case because a scenario's result is the worst verdict over its required cases. */
class Assertion extends Schema.Class<Assertion>("RoundTripAssertion")({
  status: ResultStatusSchema,
  explanation: Schema.String,
}) {}

const OptionalSubmissionSchema = Schema.Option(Submission)
const OptionalCandidateSchema = Schema.Option(Candidate)
const SubmissionsSchema = Schema.Array(Submission)

/** The evaluated subject is one required input case with its candidate and actual submissions because every criterion judges what was declared, generated, and really submitted. */
class Subject extends Schema.Class<Subject>("RoundTripSubject")({
  input: InputCase,
  candidate: OptionalCandidateSchema,
  submissions: SubmissionsSchema,
  submission: OptionalSubmissionSchema,
}) {}

/** The submitted pair every criterion judges because an approved candidate and its one real submission are the only admissible evidence. */
class Exercised extends Schema.Class<Exercised>("RoundTripExercised")({
  candidate: Candidate,
  submission: Submission,
}) {}

class TaggedFailure extends Schema.Class<TaggedFailure>("RoundTripTaggedFailure")({
  _tag: Schema.String,
}) {}

type Criterion = (operation: NativeOperation, services: CodecServices, context: EvaluationContext) => (subject: Subject) => Effect.Effect<Assertion>

type Verdict<A> = Effect.Effect<A, Assertion>

const verdict = (status: Status) => (explanation: string) => Assertion.make({ status, explanation })

const passed = verdict("pass")

const failed = verdict("fail")

const blocked = verdict("blocked")

const inconclusive = verdict("inconclusive")

const isPayload = Schema.is(PayloadSchema)

const decodeTag = Schema.decodeUnknownOption(TaggedFailure)

const tagOf = (error: Option.Option<unknown>) => pipe(error, Option.flatMap(decodeTag), Option.map(Struct.get("_tag")))

const errorMessageOf = (cause: unknown) => Predicate.isError(cause) ? cause.message : globalThis.String(cause)

const parseOptions: SchemaAST.ParseOptions = { onExcessProperty: "error" }

const keyOfEntry = ([key]: readonly [string, unknown]) => key

const byKey = Order.mapInput(Order.String, keyOfEntry)

const wireEntry = ([key, value]: readonly [string, unknown]) => {
  const name = JSON.stringify(key)
  const text = wireText(value)

  return `${name}:${text}`
}

const arrayWire = (values: ReadonlyArray<unknown>) => {
  const items = pipe(values, Array.map(wireText), Array.join(","))

  return `[${items}]`
}

const objectWire = (value: Payload) => {
  const entries = pipe(value, Record.toEntries, Array.sort(byKey), Array.map(wireEntry), Array.join(","))

  return `{${entries}}`
}

const scalarWire = (value: unknown) => pipe(JSON.stringify(value), Option.fromUndefinedOr, Option.getOrElse(Function.constant("undefined")))

/** Wire text sorts object keys because encoded values are compared independently of property order. */
const wireText = (value: unknown): string => {
  if (Array.isArray(value)) return arrayWire(value)

  return isPayload(value) ? objectWire(value) : scalarWire(value)
}

const sameWire = (left: unknown) => (right: unknown) => {
  const expected = wireText(left)
  const actual = wireText(right)

  return Equal.equals(expected, actual)
}

const withinSuccess = Number.between({ minimum: 200, maximum: 299 })

const rejectionStatuses = [400, 422]

const isAccepted = (submission: Submission) => withinSuccess(submission.status)

const settle = Effect.match({ onFailure: Function.identity<Assertion>, onSuccess: Function.identity<Assertion> })

const failUnless = (condition: boolean, otherwise: Assertion): Verdict<boolean> => condition ? Effect.succeed(condition) : Effect.fail(otherwise)

const presentOr = <E>(otherwise: E) => <A>(value: Option.Option<A>) => pipe(value, Effect.fromOption, Effect.mapError(Function.constant(otherwise)))

const successCodec = (operation: NativeOperation) => Schema.make<Schema.Codec<unknown, unknown>>(operation.successSchema.ast)

// A codec round trip decodes and re-encodes with the provided services because a lossy wire codec would otherwise pass unnoticed.
const roundTrip = (codec: Schema.Codec<unknown, unknown>, services: CodecServices) => (value: unknown) => pipe(
  value,
  Schema.decodeUnknownEffect(codec, parseOptions),
  Effect.flatMap(Schema.encodeUnknownEffect(codec, parseOptions)),
  Effect.provideContext(services),
  Effect.result,
)

const losslessly = (value: unknown) => Result.match({ onFailure: Function.constFalse, onSuccess: sameWire(value) })

const uncaptured = inconclusive("No actual browser submission of the required input was captured.")

const notSubmitted = (interruption: string) => blocked(`The required input was not submitted: ${interruption}`)

const missingEvidence = (context: EvaluationContext) => Option.match(context.interruption, { onNone: Function.constant(uncaptured), onSome: notSubmitted })

/** Every criterion first establishes exactly one real submission of an approved candidate because a missing or repeated submission is not evidence. */
const established = (context: EvaluationContext) => Effect.fn("RoundTrip.established")(function* (subject: Subject) {
  const count = Array.length(subject.submissions)
  const missingCandidate = blocked(`No candidate was resolved for the required input ${subject.input.id}.`)
  const repeated = inconclusive(`The required input ${subject.input.id} was submitted ${count} times; exactly one submission is required.`)
  const missing = missingEvidence(context)
  const candidate = yield* presentOr(missingCandidate)(subject.candidate)

  yield* failUnless(count <= 1, repeated)

  const submission = yield* presentOr(missing)(subject.submission)

  return Exercised.make({ candidate, submission })
})

const failureText = (submission: Submission) => pipe(submission.error, tagOf, Option.getOrElse(Function.constant("no tagged failure")))

const acceptedVerdict = (input: InputCase, submission: Submission) => () => {
  const clean = Option.isNone(submission.error)
  const accepted = isAccepted(submission) && clean
  const failure = failureText(submission)

  return accepted
    ? passed(`The application accepted ${input.id} with HTTP ${submission.status}.`)
    : failed(`The native-valid ${input.id} was not accepted: HTTP ${submission.status} (${failure}).`)
}

const acceptedInstead = (input: InputCase, submission: Submission) => failed(`${input.id} was declared ${input.outcome.kind} but the application accepted it with HTTP ${submission.status}.`)

const deniedVerdict = (input: InputCase, submission: Submission) => (outcome: Readonly<{ failure: string }>) => {
  const declared = pipe(submission.error, tagOf, Option.contains(outcome.failure))
  const failure = failureText(submission)

  const refusal = declared
    ? passed(`The application refused ${input.id} with the declared native failure ${outcome.failure} (HTTP ${submission.status}).`)
    : failed(`${input.id} was refused with ${failure}, not the declared native failure ${outcome.failure}.`)

  return isAccepted(submission) ? acceptedInstead(input, submission) : refusal
}

// A codec rejection carries no tagged failure because the handler never ran; a tagged failure would be policy, not the native contract.
const rejectedVerdict = (input: InputCase, submission: Submission) => () => {
  const rejectedStatus = Array.contains(rejectionStatuses, submission.status)
  const untagged = pipe(submission.error, tagOf, Option.isNone)
  const codecRejection = rejectedStatus && untagged
  const failure = failureText(submission)

  const rejection = codecRejection
    ? passed(`The application rejected ${input.id} as input outside the native contract (HTTP ${submission.status}).`)
    : failed(`${input.id} was not rejected by the native contract: HTTP ${submission.status} (${failure}).`)

  return isAccepted(submission) ? acceptedInstead(input, submission) : rejection
}

// A contended input either wins its race or is refused with one of the declared failures because which competitor wins is not determined in advance.
const contendedVerdict = (input: InputCase, submission: Submission) => (outcome: Readonly<{ failures: ReadonlyArray<string> }>) => {
  const declared = pipe(submission.error, tagOf, Option.exists(amongst(outcome.failures)))
  const failure = failureText(submission)
  const declaredList = Array.join(outcome.failures, " or ")
  const won = passed(`The application accepted the contended ${input.id} with HTTP ${submission.status}.`)

  const refusal = declared
    ? passed(`The application refused the contended ${input.id} with ${failure}, one of the declared native failures ${declaredList} (HTTP ${submission.status}).`)
    : failed(`The contended ${input.id} was refused with ${failure}, not one of the declared native failures ${declaredList}.`)

  return isAccepted(submission) ? won : refusal
}

const outcomeAssertion = (input: InputCase, submission: Submission) => pipe(
  Match.value(input.outcome),
  Match.discriminatorsExhaustive("kind")({
    accepted: acceptedVerdict(input, submission),
    denied: deniedVerdict(input, submission),
    rejected: rejectedVerdict(input, submission),
    contended: contendedVerdict(input, submission),
  }),
)

const validityText = (valid: boolean) => valid ? "native-valid" : "native-invalid"

const nativeAgreement = Effect.fn("RoundTrip.nativeAgreement")(function* (operation: NativeOperation, services: CodecServices, input: InputCase, submission: Submission) {
  const codecSchema = payloadCodec(operation)
  const decoded = yield* pipe(submission.input, Schema.decodeUnknownEffect(codecSchema, parseOptions), Effect.provideContext(services), Effect.result)
  const valid = Result.isSuccess(decoded)
  const judged = validityText(valid)
  const declaredValid = Equal.equals(input.validity, "native-valid")
  const reason = Result.match(decoded, { onFailure: errorMessageOf, onSuccess: Function.constant("accepted") })
  const disagreement = failed(`The exact native ${operation._tag} codec judges the submitted ${input.id} ${judged}, not ${input.validity}: ${reason}`)
  const agrees = Equal.equals(valid, declaredValid)

  yield* failUnless(agrees, disagreement)
})

const harnessMismatch = (submission: Submission) => pipe(submission.error, tagOf, Option.contains("SubmittedInputMismatch"))

const exactlyEntered = (exercised: Exercised) => {
  const exact = sameWire(exercised.submission.input)(exercised.candidate.input)
  const mismatch = harnessMismatch(exercised.submission)
  const faithful = !mismatch

  return exact && faithful
}

const declaredOutcome: Criterion = (operation, services, context) => Effect.fn("RoundTrip.declaredOutcome")(function* (subject: Subject) {
  const exercised = yield* established(context)(subject)
  const { candidate, submission } = exercised
  const sameValidity = Equal.equals(candidate.validity, subject.input.validity)
  const exact = exactlyEntered(exercised)
  const wrongValidity = failed(`The candidate for ${subject.input.id} was generated ${candidate.validity}, not the declared ${subject.input.validity}.`)
  const otherEntry = failed(`The browser submitted a value for ${subject.input.id} other than the approved candidate.`)

  yield* failUnless(sameValidity, wrongValidity)
  yield* failUnless(exact, otherEntry)
  yield* nativeAgreement(operation, services, subject.input, submission)

  return outcomeAssertion(subject.input, submission)
}, settle)

const fieldsOf = (value: unknown) => isPayload(value) ? value : Record.empty<string, unknown>()

const isStructured = (value: unknown) => Array.isArray(value) || isPayload(value)

const itemsOf = (value: unknown) => Array.isArray(value) ? value : Array.empty<unknown>()

const pairIncluded = ([container, value]: readonly [unknown, unknown]) => isIncluded(container, value)

const memberIncluded = (fields: Payload) => ([key, member]: readonly [string, unknown]) => pipe(fields, Record.get(key), Option.exists(holderOf(member)))

const arrayIncluded = (container: unknown, value: ReadonlyArray<unknown>) => {
  const items = itemsOf(container)
  const sameLength = Equal.equals(items.length, value.length)
  const pairs = Array.zip(items, value)

  return sameLength && Array.every(pairs, pairIncluded)
}

const objectIncluded = (container: unknown, value: Payload) => {
  const fields = fieldsOf(container)
  const entries = Record.toEntries(value)

  return isPayload(container) && Array.every(entries, memberIncluded(fields))
}

/** Inclusion is structural because an accepted value must reappear with every submitted member, nested members included, exactly as encoded. */
const isIncluded = (container: unknown, value: unknown): boolean => {
  if (Array.isArray(value)) return arrayIncluded(container, value)

  return isPayload(value) ? objectIncluded(container, value) : sameWire(container)(value)
}

const holderOf = (value: unknown) => (container: unknown) => isIncluded(container, value)

const containedNodes = (value: unknown): ReadonlyArray<unknown> => {
  const fields = fieldsOf(value)
  const children = Array.isArray(value) ? value : Record.values(fields)
  const nested = Array.flatMap(children, containedNodes)

  return Array.prepend(nested, value)
}

const holdsAnywhere = (value: unknown) => (container: unknown) => pipe(container, containedNodes, Array.some(holderOf(value)))

const isBefore = (record: ProbeRecord) => Equal.equals(record.phase, "before")

const isAfter = (record: ProbeRecord) => Text.startsWith("after")(record.phase)

const probeValue = (record: ProbeRecord) => Option.getOrNull(record.result)

const freshlyIn = (input: Payload, before: ReadonlyArray<unknown>) => (value: unknown) => {
  const contained = holdsAnywhere(input)(value)
  const preexisting = Array.some(before, holdsAnywhere(input))
  const absentBefore = !preexisting

  return contained && absentBefore
}

const freshProbe = (input: Payload, before: ReadonlyArray<unknown>) => flow(probeValue, freshlyIn(input, before))

const probeWhere = (record: ProbeRecord) => `the ${record.probe} probe of ${record.subject} (${record.phase}), absent before`

const retainedEvidence = (context: EvaluationContext, input: Payload) => {
  const beforeRows = Array.flatMap(context.before, Struct.get("rows"))
  const afterRows = Array.flatMap(context.after, Struct.get("rows"))
  const beforeProbes = pipe(context.probes, Array.filter(isBefore), Array.map(probeValue))
  const afterProbes = Array.filter(context.probes, isAfter)
  const row = Array.some(afterRows, freshlyIn(input, beforeRows))
  const probe = pipe(afterProbes, Array.findFirst(freshProbe(input, beforeProbes)), Option.map(probeWhere))
  const rowWhere = Option.some("a row of the declared observation that was absent before")

  return row ? rowWhere : probe
}

const unretained = (operation: NativeOperation, subject: Subject) =>
  pipe(failed(`Neither the accepted ${operation._tag} result nor a declared observation or probe contains the submitted ${subject.input.id} values exactly.`), Function.constant)

const retainedAt = (subject: Subject, reference: string) => (where: string) =>
  passed(`The submitted ${subject.input.id} values decode and re-encode natively without loss; the result (${reference}) is a reference, and ${where} contains every submitted encoded member.`)

const losslessRoundTrip: Criterion = (operation, services, context) => Effect.fn("RoundTrip.losslessRoundTrip")(function* (subject: Subject) {
  const { submission } = yield* established(context)(subject)
  const accepting = Equal.equals(subject.input.outcome.kind, "accepted")
  const acceptedStatus = isAccepted(submission)
  const notApplicable = blocked(`Lossless round trip applies only to accepted inputs; ${subject.input.id} is declared ${subject.input.outcome.kind}.`)
  const notAccepted = failed(`The native-valid ${subject.input.id} was not accepted (HTTP ${submission.status}).`)

  yield* failUnless(accepting, notApplicable)
  yield* failUnless(acceptedStatus, notAccepted)

  const { input } = submission
  const payloadSchema = payloadCodec(operation)
  const reencoded = yield* roundTrip(payloadSchema, services)(input)
  const inputLossless = losslessly(input)(reencoded)
  const lossyInput = failed(`The submitted ${subject.input.id} does not decode and re-encode through the native ${operation._tag} codec without loss.`)
  const resultless = inconclusive(`The accepted ${subject.input.id} response carries no decoded operation result.`)

  yield* failUnless(inputLossless, lossyInput)

  const result = yield* presentOr(resultless)(submission.result)
  const successSchema = successCodec(operation)
  const resultTrip = yield* roundTrip(successSchema, services)(result)
  const resultLossless = losslessly(result)(resultTrip)
  const lossyResult = failed(`The ${operation._tag} result does not decode and re-encode through the native success codec without loss.`)
  const echoed = holdsAnywhere(input)(result)
  const reference = !isStructured(result)
  const dropped = failed(`The accepted ${operation._tag} result does not contain the submitted ${subject.input.id} values exactly.`)
  const contained = passed(`The submitted ${subject.input.id} values decode and re-encode natively without loss and the accepted result contains every submitted encoded member.`)
  const referenceText = wireText(result)

  yield* failUnless(resultLossless, lossyResult)

  if (echoed) return contained

  // Only a reference result may defer to stored evidence because a structured result that drops a submitted value is itself lossy.
  yield* failUnless(reference, dropped)

  const retained = retainedEvidence(context, input)

  return Option.match(retained, { onNone: unretained(operation, subject), onSome: retainedAt(subject, referenceText) })
}, settle)

const pointer = (path: string, key: PropertyKey) => `${path}/${globalThis.String(key)}`

const elementType = (ast: SchemaAST.Arrays, index: number) => {
  const rest = Array.head(ast.rest)

  return pipe(ast.elements, Array.get(index), Option.orElse(Function.constant(rest)))
}

const forbiddenElement = (ast: SchemaAST.Arrays, path: string) => (item: unknown, index: number) => {
  const type = elementType(ast, index)
  const nested = (member: SchemaAST.AST) => forbiddenPointers(member, item, `${path}/${index}`)

  return Option.match(type, { onNone: Array.empty<string>, onSome: nested })
}

const forbiddenMember = (fields: Payload, path: string) => (signature: SchemaAST.PropertySignature): ReadonlyArray<string> => {
  const key = globalThis.String(signature.name)
  const supplied = Record.get(fields, key)
  const here = pointer(path, signature.name)
  const nested = (value: unknown) => forbiddenPointers(signature.type, value, here)
  const suppliedForbidden = Option.isSome(supplied) ? Array.of(here) : Array.empty<string>()

  return isOptionalNever(signature) ? suppliedForbidden : Option.match(supplied, { onNone: Array.empty<string>, onSome: nested })
}

const suspendedSupplied = (value: unknown, path: string) => (ast: SchemaAST.Suspend) => {
  const resolved = ast.thunk()

  return forbiddenPointers(resolved, value, path)
}

const unionSupplied = (value: unknown, path: string) => (ast: SchemaAST.Union) => {
  const member = (type: SchemaAST.AST) => forbiddenPointers(type, value, path)

  return pipe(ast.types, Array.flatMap(member), Array.dedupe)
}

const arraysSupplied = (value: unknown, path: string) => (ast: SchemaAST.Arrays) => {
  const items = itemsOf(value)

  return Array.flatMap(items, forbiddenElement(ast, path))
}

const objectsSupplied = (value: unknown, path: string) => (ast: SchemaAST.Objects) => {
  const fields = fieldsOf(value)

  return Array.flatMap(ast.propertySignatures, forbiddenMember(fields, path))
}

/** Walks the caller type with the submitted value because forbidden members may sit inside nested objects and arrays. */
const forbiddenPointers = (ast: SchemaAST.AST, value: unknown, path: string): ReadonlyArray<string> => pipe(
  Match.value(ast),
  Match.when(SchemaAST.isSuspend, suspendedSupplied(value, path)),
  Match.when(SchemaAST.isUnion, unionSupplied(value, path)),
  Match.when(SchemaAST.isArrays, arraysSupplied(value, path)),
  Match.when(SchemaAST.isObjects, objectsSupplied(value, path)),
  Match.orElse(Array.empty<string>),
)

const forbiddenDeclared = (path: string) => (signature: SchemaAST.PropertySignature): ReadonlyArray<string> => {
  const here = pointer(path, signature.name)

  return isOptionalNever(signature) ? Array.of(here) : forbiddenMembers(signature.type, here)
}

const signaturesOf = (ast: SchemaAST.AST) => SchemaAST.isObjects(ast) ? ast.propertySignatures : Array.empty<SchemaAST.PropertySignature>()

const forbiddenMembers = (ast: SchemaAST.AST, path: string): ReadonlyArray<string> => pipe(ast, signaturesOf, Array.flatMap(forbiddenDeclared(path)))

const signatureName = (signature: SchemaAST.PropertySignature) => globalThis.String(signature.name)

const callerFields = flow(signaturesOf, Array.filter(Predicate.not(isOptionalNever)), Array.map(signatureName))

const rootPointer = (field: string) => `/${field}`

const listText = (values: ReadonlyArray<string>, none: string, some: string) => Array.isReadonlyArrayEmpty(values) ? none : `${some} ${Array.join(values, ", ")}`

const generatedExcluded: Criterion = (operation, _services, context) => Effect.fn("RoundTrip.generatedExcluded")(function* (subject: Subject) {
  const exercised = yield* established(context)(subject)
  const { submission } = exercised
  const type = SchemaAST.toType(operation.payloadSchema.ast)
  const forbidden = forbiddenMembers(type, "")
  const supplied = forbiddenPointers(type, submission.input, "")
  const caller = callerFields(type)
  const declared = pipe(subject.input.fields, Record.keys, Array.map(rootPointer))
  const sourcedForbidden = Array.filter(declared, amongst(forbidden))
  const resultFields = pipe(submission.result, Option.filter(isPayload), Option.map(Record.keys), Option.getOrElse(Array.empty<string>))
  const generated = Array.filter(resultFields, Predicate.not(amongst(caller)))
  const submittedFields = Record.keys(submission.input)
  const leakedGenerated = Array.filter(submittedFields, amongst(generated))
  const outside = Array.filter(submittedFields, Predicate.not(amongst(caller)))
  const exact = exactlyEntered(exercised)
  const forbiddenText = listText(forbidden, "no forbidden members", "forbidden members")
  const generatedText = listText(generated, "no result-only fields", "result-only generated fields")
  const sourcedText = Array.join(sourcedForbidden, ", ")
  const suppliedText = Array.join(supplied, ", ")
  const leakedText = Array.join(leakedGenerated, ", ")
  const outsideText = Array.join(outside, ", ")
  const submittedText = Array.join(submittedFields, ", ")
  const noneSourced = Array.isReadonlyArrayEmpty(sourcedForbidden)
  const noneSupplied = Array.isReadonlyArrayEmpty(supplied)
  const noneLeaked = Array.isReadonlyArrayEmpty(leakedGenerated)
  const noneOutside = Array.isReadonlyArrayEmpty(outside)
  const sourcedViolation = failed(`The ${subject.input.id} declaration sources the forbidden member(s) ${sourcedText}.`)
  const otherEntry = failed(`The browser submitted a value for ${subject.input.id} other than the approved candidate.`)
  const suppliedViolation = failed(`The submitted ${subject.input.id} supplies forbidden generated or trusted member(s) ${suppliedText}.`)
  const leakedViolation = failed(`The submitted ${subject.input.id} supplies server-generated field(s) ${leakedText}.`)
  const outsideViolation = failed(`The submitted ${subject.input.id} names field(s) outside the ${operation._tag} caller payload: ${outsideText}.`)

  yield* failUnless(noneSourced, sourcedViolation)
  yield* failUnless(exact, otherEntry)
  yield* failUnless(noneSupplied, suppliedViolation)
  yield* failUnless(noneLeaked, leakedViolation)
  yield* failUnless(noneOutside, outsideViolation)

  return passed(`The submitted ${subject.input.id} names only caller fields of ${operation._tag} (${submittedText}); ${forbiddenText} and ${generatedText} are absent from the input.`)
}, settle)

const ofResource = (resource: string) => (view: Observation) => Equal.equals(view.resource, resource)

const usable = (view: Observation) => Array.every([view.loaded, view.unfiltered, view.complete], Function.identity)

const rowCounts = (rows: ReadonlyArray<Payload>) => pipe(rows, Array.map(wireText), Array.groupBy(Function.identity), Record.map(Array.length), Record.toEntries, HashMap.fromIterable)

const sameRows = (before: ReadonlyArray<Payload>, after: ReadonlyArray<Payload>) => {
  const beforeCounts = rowCounts(before)
  const afterCounts = rowCounts(after)

  return Equal.equals(beforeCounts, afterCounts)
}

const observationVerdict = (scenario: Scenario, context: EvaluationContext) => Effect.fn("RoundTrip.observationVerdict")(function* (resource: string) {
  const beforeView = Array.findFirst(context.before, ofResource(resource))
  const afterView = Array.findFirst(context.after, ofResource(resource))
  const noBefore = inconclusive(`No before view of ${resource} was captured.`)
  const noAfter = inconclusive(`No after view of ${resource} was captured.`)
  const before = yield* presentOr(noBefore)(beforeView)
  const after = yield* presentOr(noAfter)(afterView)
  const reloadHeld = scenario.reload ? after.reloaded : true
  const seeded = Array.isReadonlyArrayNonEmpty(before.rows)
  const bothUsable = Array.every([before, after], usable)
  const unchanged = sameRows(before.rows, after.rows)
  const unusable = inconclusive(`The ${resource} views are not both loaded, unfiltered, and complete.`)
  const unreloaded = inconclusive(`The after view of ${resource} was not captured after the declared reload.`)
  const unseeded = inconclusive(`The before view of ${resource} establishes no prepared record, so an empty after view would prove nothing.`)
  const changed = failed(`The ${resource} rows changed: ${before.rows.length} before, ${after.rows.length} after, with added, removed, or altered rows.`)

  yield* failUnless(bothUsable, unusable)
  yield* failUnless(reloadHeld, unreloaded)
  yield* failUnless(seeded, unseeded)
  yield* failUnless(unchanged, changed)

  return passed(`The ${resource} view holds exactly the same ${before.rows.length} row(s) before and after.`)
}, settle)

const probeKey = (record: ProbeRecord) => `${record.probe}\u0000${record.subject}`

const probeState = (record: ProbeRecord) => {
  const result = Option.getOrNull(record.result)
  const error = Option.getOrNull(record.error)

  return wireText([record.status, result, error])
}

const sameProbe = (key: string) => (record: ProbeRecord) => {
  const recordKey = probeKey(record)

  return Equal.equals(recordKey, key)
}

const probeVerdict = (context: EvaluationContext) => Effect.fn("RoundTrip.probeVerdict")(function* (before: ProbeRecord) {
  const key = probeKey(before)
  const after = pipe(context.probes, Array.filter(isAfter), Array.findLast(sameProbe(key)))
  const succeeded = withinSuccess(before.status)
  const answered = succeeded && Option.isSome(before.result)
  const unrecorded = inconclusive(`No after probe ${before.probe} of ${before.subject} was recorded.`)
  const unanswered = inconclusive(`The before probe ${before.probe} of ${before.subject} did not answer with a result (HTTP ${before.status}).`)
  const closing = yield* presentOr(unrecorded)(after)
  const beforeState = probeState(before)
  const afterState = probeState(closing)
  const unchanged = Equal.equals(beforeState, afterState)
  const changed = failed(`The ${before.probe} probe of ${before.subject} changed between the before and after phases.`)

  yield* failUnless(answered, unanswered)
  yield* failUnless(unchanged, changed)

  return passed(`The ${before.probe} probe of ${before.subject} is exactly unchanged.`)
}, settle)

const noObservation = inconclusive("The scenario declares no observation or probe that could establish the absence of effects.")

const observationUnchanged: Criterion = (_operation, _services, context) => Effect.fn("RoundTrip.observationUnchanged")(function* (subject: Subject) {
  yield* established(context)(subject)

  const views = yield* Effect.forEach(context.scenario.observations, observationVerdict(context.scenario, context))
  const beforeProbes = Array.filter(context.probes, isBefore)
  const probes = yield* Effect.forEach(beforeProbes, probeVerdict(context))
  const verdicts = Array.appendAll(views, probes)
  const observed = Array.isReadonlyArrayNonEmpty(verdicts)

  yield* failUnless(observed, noObservation)

  return worst(verdicts)
}, settle)

const severities: ReadonlyArray<Status> = ["pass", "inconclusive", "blocked", "fail"]

const severityOf = (assertion: Assertion) => pipe(severities, Array.findFirstIndex(Equal.equals(assertion.status)), Option.getOrElse(Function.constant(0)))

const bySeverity = Order.mapInput(Order.Number, severityOf)

const statusAt = (index: number) => pipe(severities, Array.get(index), Option.getOrElse(Function.constant<Status>("pass")))

const worst = (verdicts: ReadonlyArray<Assertion>) => {
  const status = pipe(verdicts, Array.map(severityOf), Array.reduce(0, Order.max(Order.Number)), statusAt)
  const explanation = pipe(verdicts, Array.sort(Order.flip(bySeverity)), Array.map(Struct.get("explanation")), Array.join(" "))

  return Assertion.make({ status, explanation })
}

const criteria = HashMap.make<ReadonlyArray<readonly [string, Criterion]>>(
  ["declared-outcome", declaredOutcome],
  ["lossless-roundtrip", losslessRoundTrip],
  ["generated-excluded", generatedExcluded],
  ["observation-unchanged", observationUnchanged],
)

/** Generation-matrix evaluators are generic over the application because they judge native contracts, candidates, and submissions, never application policy. */
export const roundTripEvaluators: Readonly<Record<string, string>> = pipe(criteria, HashMap.map(Function.constant("1")), Record.fromEntries)

const ofCase = (id: string) => (entry: Candidate | Submission) => Equal.equals(entry.inputCase, id)

const subjectOf = (context: EvaluationContext) => (input: InputCase) => {
  const candidate = Array.findLast(context.candidates, ofCase(input.id))
  const submissions = Array.filter(context.submissions, ofCase(input.id))
  const submission = Array.head(submissions)

  return Subject.make({ input, candidate, submissions, submission })
}

const byRequired = (scenario: Scenario) => (input: InputCase) => Array.contains(scenario.required, input.id)

const taggedAs = (name: string) => (operation: NativeOperation) => Equal.equals(operation._tag, name)

const foreignOperation = (subject: Subject) => {
  const foreign = blocked(`The native operation ${subject.input.operation} of ${subject.input.id} is not part of the evaluated application.`)
  const settled = Effect.succeed(foreign)

  return Function.constant(settled)
}

const evaluateWith = (operations: ReadonlyArray<NativeOperation>, services: CodecServices, criterion: Criterion, context: EvaluationContext) => (subject: Subject) => {
  const operation = Array.findFirst(operations, taggedAs(subject.input.operation))
  const judge = (native: NativeOperation) => criterion(native, services, context)(subject)

  return Option.match(operation, { onNone: foreignOperation(subject), onSome: judge })
}

const resultOf = (requirement: BoundRequirement, context: EvaluationContext) => (assertion: Assertion) => RequirementResult.make({
  requirement: requirement.reference,
  requirementRevision: requirement.revision,
  scenario: context.scenario.id,
  scenarioRevision: context.scenario.revision,
  evaluator: requirement.evaluator,
  evaluatorRevision: requirement.evaluatorRevision,
  basis: "executable assertion",
  status: assertion.status,
  explanation: assertion.explanation,
  evidence: context.evidence,
})

const unrequired = blocked("The scenario declares no required input case to evaluate.")

const evaluate = (operations: ReadonlyArray<NativeOperation>, services: CodecServices) => Effect.fn("RoundTrip.evaluate")(function* (requirement: BoundRequirement, context: EvaluationContext) {
  const revision = Record.get(roundTripEvaluators, requirement.evaluator)
  const current = Option.contains(revision, requirement.evaluatorRevision)
  const criterion = pipe(criteria, HashMap.get(requirement.evaluator), Option.filter(Function.constant(current)))
  const unknown = AcceptanceError.make({ boundary: "evaluation", message: `No round-trip evaluator ${requirement.evaluator}@${requirement.evaluatorRevision}` })
  const bound = yield* presentOr(unknown)(criterion)
  const subjects = pipe(context.scenario.inputs, Array.filter(byRequired(context.scenario)), Array.map(subjectOf(context)))
  const verdicts = yield* Effect.forEach(subjects, evaluateWith(operations, services, bound, context))
  const judged = Array.isReadonlyArrayNonEmpty(verdicts) ? worst(verdicts) : unrequired

  return resultOf(requirement, context)(judged)
})

/** The evaluation layer binds the application's native operations and codec services because every criterion decodes with the exact served contract. */
export const roundTripLayer = (application: ApplicationIR, services: CodecServices): Layer.Layer<RequirementEvaluation> => {
  const operations = nativeOperations(application)
  const service = RequirementEvaluation.of({ evaluate: evaluate(operations, services) })

  return Layer.succeed(RequirementEvaluation, service)
}

class NoteRefused extends Schema.TaggedError<NoteRefused>()("NoteRefused", {}) {}

class NoteForbidden extends Schema.TaggedError<NoteForbidden>()("Forbidden", {}) {}

const GeneratedIdSchema = Schema.optionalKey(Schema.Never)
const TagsSchema = Schema.Array(Schema.String)

const ControlNoteSchema = Schema.Struct({ title: Schema.NonEmptyString, tags: TagsSchema, id: GeneratedIdSchema })

interface ControlNote extends Schema.Schema.Type<typeof ControlNoteSchema> {}

const ControlRowSchema = Schema.Struct({ id: Schema.String, title: Schema.NonEmptyString, tags: TagsSchema })

interface ControlRow extends Schema.Schema.Type<typeof ControlRowSchema> {}

const recordControl = Rpc.make("notes.record", { payload: ControlNoteSchema, success: ControlRowSchema, error: NoteRefused })
const submitControl = Rpc.make("notes.submit", { payload: ControlNoteSchema, success: Schema.String, error: NoteRefused })
const controlGroup = RpcGroup.make(recordControl, submitControl)
const controlParts = [Part.native({ group: controlGroup, handlers: Layer.empty })]
const controlDefinition = Application.define({ name: "acceptance-roundtrip-controls", parts: controlParts })
const controlCompiler = Application.compile(controlDefinition)

// The control application compiles synchronously because it is a pure definition whose handlers are never served.
const controlApplication = Effect.runSync(controlCompiler)

const controlLabel = "deliberately constructed round-trip verifier control; not browser or model execution"
const at = "2026-10-10T00:00:00.000Z"
const pair = ["alpha", "beta"]
const sentinel = PayloadSchema.make({ id: "note-sentinel", title: "Unrelated note", tags: ["keep"] })
const submitted = PayloadSchema.make({ title: "Generated note", tags: pair })
const otherSubmitted = PayloadSchema.make({ title: "Other note", tags: pair })
const created = PayloadSchema.make({ id: "note-created", title: "Generated note", tags: pair })
const altered = PayloadSchema.make({ id: "note-created", title: "Altered note", tags: pair })
const otherCreated = PayloadSchema.make({ id: "note-created", title: "Other note", tags: pair })
const invalidInput = PayloadSchema.make({ title: "", tags: ["alpha"] })
const invalidCreated = PayloadSchema.make({ id: "note-invalid", title: "", tags: ["alpha"] })
const forgedInput = PayloadSchema.make({ id: "forged-id", title: "Generated note", tags: pair })
const stored = PayloadSchema.make({ id: "note-created", request: submitted })
const codecRejection = PayloadSchema.make({ message: "Invalid input for notes.record" })
const refusedError = NoteRefused.make({})
const forbiddenError = NoteForbidden.make({})
const literalSource = (value: unknown) => LiteralSourceSchema.make({ source: "literal", value })
const accepted: InputCase["outcome"] = { kind: "accepted" }
const rejected: InputCase["outcome"] = { kind: "rejected" }
const refused: InputCase["outcome"] = { kind: "denied", failure: "NoteRefused" }

const controlCase = (operation: string, validity: InputCase["validity"], outcome: InputCase["outcome"]) => (values: Payload) => InputCase.make({
  id: "control",
  operation,
  description: controlLabel,
  fields: Record.map(values, literalSource),
  validity,
  outcome,
})

const recordCase = controlCase("notes.record", "native-valid", accepted)(submitted)
const submitCase = controlCase("notes.submit", "native-valid", accepted)(submitted)
const invalidCase = controlCase("notes.record", "native-invalid", rejected)(invalidInput)
const refusedCase = controlCase("notes.record", "native-valid", refused)(submitted)
const forgedCase = controlCase("notes.record", "native-valid", accepted)(forgedInput)

const ExpectedSchema = Schema.Record(Schema.String, ResultStatusSchema)
const ObservationsSchema = Schema.Array(Observation)
const ProbeRecordsSchema = Schema.Array(ProbeRecord)

/** A control is a constructed evaluation context with the verdicts the evaluators must reach because detection is defined against known defects. */
class Control extends Schema.Class<Control>("RoundTripControl")({
  id: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  input: InputCase,
  candidate: PayloadSchema,
  submissions: SubmissionsSchema,
  before: ObservationsSchema,
  after: ObservationsSchema,
  probes: ProbeRecordsSchema,
  expected: ExpectedSchema,
}) {}

const view = (reloaded: boolean) => (rows: ReadonlyArray<Payload>) => Observation.make({ operation: "notes.list", resource: "notes", loaded: true, unfiltered: true, complete: true, rows, reloaded, screenshot: Option.none() })

const beforeView = view(false)

const afterView = view(true)

const probeAt = (phase: string) => (result: unknown) => ProbeRecord.make({ probe: "stored-notes", phase, subject: "tenant", actor: "control", at, status: 200, result: Option.some(result), error: Option.none() })

const answered = (operation: string, input: Payload, status: number) => (result: unknown) => Submission.make({ inputCase: "control", operation, input, status, result: Option.some(result), error: Option.none(), at, exchange: Option.none(), feedback: Option.none() })

const refusedWith = (input: Payload, status: number) => (error: unknown) => Submission.make({ inputCase: "control", operation: "notes.record", input, status, result: Option.none(), error: Option.some(error), at, exchange: Option.none(), feedback: Option.none() })

const unchangedBefore = [beforeView([sentinel])]
const unchangedAfter = [afterView([sentinel])]
const createdAfter = [afterView([sentinel, created])]
const unloadedAfter = [Observation.make({ operation: "notes.list", resource: "notes", loaded: false, unfiltered: true, complete: true, rows: [], reloaded: true, screenshot: Option.none() })]
const createdSubmission = answered("notes.record", submitted, 200)(created)
const lossySubmission = answered("notes.record", submitted, 200)(altered)
const mismatchedSubmission = answered("notes.record", otherSubmitted, 200)(otherCreated)
const forgedSubmission = answered("notes.record", forgedInput, 200)(forgedInput)
const acceptedInvalid = answered("notes.record", invalidInput, 200)(invalidCreated)
const referenceSubmission = answered("notes.submit", submitted, 200)("note-created")
const rejection = refusedWith(invalidInput, 400)(codecRejection)
const refusal = refusedWith(submitted, 422)(refusedError)
const otherRefusal = refusedWith(submitted, 422)(forbiddenError)
const storedBefore = probeAt("before")([sentinel])
const storedAfter = probeAt("after")([sentinel, stored])
const unstoredAfter = probeAt("after")([sentinel])

const controls = [
  Control.make({ id: "clean-accepted", description: "A clean accepted creation whose result echoes the submitted values", input: recordCase, candidate: submitted, submissions: [createdSubmission], before: unchangedBefore, after: createdAfter, probes: [], expected: { "declared-outcome": "pass", "lossless-roundtrip": "pass", "generated-excluded": "pass", "observation-unchanged": "fail" } }),
  Control.make({ id: "lossy-result", description: "An accepted creation whose result alters a submitted value", input: recordCase, candidate: submitted, submissions: [lossySubmission], before: unchangedBefore, after: createdAfter, probes: [], expected: { "declared-outcome": "pass", "lossless-roundtrip": "fail" } }),
  Control.make({ id: "mismatched-entry", description: "The browser submitted a value other than the approved candidate", input: recordCase, candidate: submitted, submissions: [mismatchedSubmission], before: unchangedBefore, after: createdAfter, probes: [], expected: { "declared-outcome": "fail", "generated-excluded": "fail" } }),
  Control.make({ id: "forged-generated", description: "The submitted input supplies the forbidden generated id", input: forgedCase, candidate: forgedInput, submissions: [forgedSubmission], before: unchangedBefore, after: createdAfter, probes: [], expected: { "declared-outcome": "fail", "generated-excluded": "fail" } }),
  Control.make({ id: "clean-rejection", description: "A native-invalid input rejected without effects", input: invalidCase, candidate: invalidInput, submissions: [rejection], before: unchangedBefore, after: unchangedAfter, probes: [], expected: { "declared-outcome": "pass", "generated-excluded": "pass", "observation-unchanged": "pass", "lossless-roundtrip": "blocked" } }),
  Control.make({ id: "accepted-invalid", description: "A native-invalid input the application accepted", input: invalidCase, candidate: invalidInput, submissions: [acceptedInvalid], before: unchangedBefore, after: createdAfter, probes: [], expected: { "declared-outcome": "fail", "observation-unchanged": "fail" } }),
  Control.make({ id: "rejected-with-effect", description: "A rejected input that still added a row", input: invalidCase, candidate: invalidInput, submissions: [rejection], before: unchangedBefore, after: createdAfter, probes: [], expected: { "declared-outcome": "pass", "observation-unchanged": "fail" } }),
  Control.make({ id: "clean-refusal", description: "A native-valid input refused with the declared failure and no effects", input: refusedCase, candidate: submitted, submissions: [refusal], before: unchangedBefore, after: unchangedAfter, probes: [], expected: { "declared-outcome": "pass", "observation-unchanged": "pass" } }),
  Control.make({ id: "wrong-refusal", description: "A refusal with a failure other than the declared one", input: refusedCase, candidate: submitted, submissions: [otherRefusal], before: unchangedBefore, after: unchangedAfter, probes: [], expected: { "declared-outcome": "fail" } }),
  Control.make({ id: "reference-retained", description: "An accepted submission returning a reference whose stored request the after probe shows", input: submitCase, candidate: submitted, submissions: [referenceSubmission], before: [], after: [], probes: [storedBefore, storedAfter], expected: { "declared-outcome": "pass", "lossless-roundtrip": "pass", "observation-unchanged": "fail" } }),
  Control.make({ id: "reference-lost", description: "An accepted submission returning a reference whose request was never stored", input: submitCase, candidate: submitted, submissions: [referenceSubmission], before: [], after: [], probes: [storedBefore, unstoredAfter], expected: { "lossless-roundtrip": "fail", "observation-unchanged": "pass" } }),
  Control.make({ id: "missing-submission", description: "No submission was captured", input: recordCase, candidate: submitted, submissions: [], before: unchangedBefore, after: createdAfter, probes: [], expected: { "declared-outcome": "inconclusive", "lossless-roundtrip": "inconclusive", "generated-excluded": "inconclusive", "observation-unchanged": "inconclusive" } }),
  Control.make({ id: "unloaded-after", description: "The after view did not load", input: invalidCase, candidate: invalidInput, submissions: [rejection], before: unchangedBefore, after: unloadedAfter, probes: [], expected: { "observation-unchanged": "inconclusive" } }),
]

const controlFixture = PreparedFixture.make({ binding: "control", revision: "control", url: "about:blank", actor: "control", facts: {}, tracked: ["tenant"] })

const observedResources = (control: Control) => Array.isReadonlyArrayEmpty(control.before) ? Array.empty<string>() : Array.of("notes")

const probedNames = (control: Control) => Array.isReadonlyArrayEmpty(control.probes) ? Array.empty<string>() : Array.of("stored-notes")

const contextOf = (control: Control) => {
  const { input } = control

  const scenario = Scenario.make({
    id: `roundtrip-${control.id}`,
    revision: "1",
    provenance: controlLabel,
    approval: "approved",
    story: "control",
    actor: "control",
    fixture: "control",
    goal: controlLabel,
    operations: [input.operation],
    inputs: [input],
    required: [input.id],
    observations: observedResources(control),
    probes: probedNames(control),
    requirements: [],
    assessments: [],
    reload: true,
    concurrency: Option.none(),
    watch: Option.none(),
  })

  const candidate = Candidate.make({ inputCase: input.id, operation: input.operation, description: controlLabel, input: control.candidate, sources: input.fields, validity: input.validity, nativeValidation: controlLabel, provenance: controlLabel, seed: 0 })

  return EvaluationContext.make({
    scenario,
    fixture: controlFixture,
    candidates: [candidate],
    submissions: control.submissions,
    before: control.before,
    after: control.after,
    probes: control.probes,
    directProbe: Option.none(),
    barrier: Option.none(),
    watch: Option.none(),
    interruption: Option.none(),
    evidence: [],
  })
}

const ResultsSchema = Schema.Array(RequirementResult)

class ControlOutcome extends Schema.Class<ControlOutcome>("RoundTripControlOutcome")({
  id: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  expected: ExpectedSchema,
  results: ResultsSchema,
  falseAcceptance: Schema.Int,
  falseRejection: Schema.Int,
  unexpectedStatuses: Schema.Int,
}) {}

const ControlOutcomesSchema = Schema.Array(ControlOutcome)

class VerifierSummary extends Schema.Class<VerifierSummary>("RoundTripVerifierSummary")({
  cases: Schema.Int,
  criteria: Schema.Int,
  falseAcceptance: Schema.Int,
  falseRejection: Schema.Int,
  unexpectedStatuses: Schema.Int,
}) {}

const RevisionsSchema = Schema.Record(Schema.String, Schema.String)

/** The report is retained with every run because a generation-matrix pass is only meaningful if its evaluators reject constructed defects. */
class RoundTripVerifierReport extends Schema.Class<RoundTripVerifierReport>("RoundTripVerifierReport")({
  evaluators: RevisionsSchema,
  summary: VerifierSummary,
  cases: ControlOutcomesSchema,
  limitation: Schema.String,
}) {}

const noServices = Context.empty()

const controlEvaluation = roundTripLayer(controlApplication, noServices)

const controlRequirement = (evaluator: string) => BoundRequirement.make({
  reference: evaluator,
  id: evaluator,
  revision: "1",
  text: controlLabel,
  category: "behavior",
  evaluator,
  evaluatorRevision: "1",
})

const judgedBy = (context: EvaluationContext) => Effect.fn("RoundTrip.verifyCriterion")(function* (evaluator: string) {
  const evaluation = yield* RequirementEvaluation
  const requirement = controlRequirement(evaluator)

  return yield* evaluation.evaluate(requirement, context)
})

type Expected = typeof ExpectedSchema.Type

const expectedOf = (expected: Expected) => (result: RequirementResult) => Record.get(expected, result.evaluator)

const falselyAccepted = (expected: Expected) => (result: RequirementResult) => {
  const wanted = expectedOf(expected)(result)
  const pass = Equal.equals(result.status, "pass")
  const shouldPass = Option.contains(wanted, "pass")
  const shouldNotPass = !shouldPass

  return pass && shouldNotPass
}

const falselyRejected = (expected: Expected) => (result: RequirementResult) => {
  const wanted = expectedOf(expected)(result)
  const failing = Equal.equals(result.status, "fail")

  return failing && Option.contains(wanted, "pass")
}

const unexpected = (expected: Expected) => (result: RequirementResult) => {
  const wanted = expectedOf(expected)(result)
  const matched = Option.contains(wanted, result.status)
  const acceptedFalsely = falselyAccepted(expected)(result)
  const rejectedFalsely = falselyRejected(expected)(result)
  const counted = acceptedFalsely || rejectedFalsely
  const mismatched = !matched
  const uncounted = !counted

  return mismatched && uncounted
}

const verifyControl = Effect.fn("RoundTrip.verifyControl")(function* (control: Control) {
  const evaluators = Record.keys(control.expected)
  const context = contextOf(control)
  const results = yield* Effect.forEach(evaluators, judgedBy(context))

  return ControlOutcome.make({
    id: control.id,
    description: control.description,
    expected: control.expected,
    results,
    falseAcceptance: Array.countBy(results, falselyAccepted(control.expected)),
    falseRejection: Array.countBy(results, falselyRejected(control.expected)),
    unexpectedStatuses: Array.countBy(results, unexpected(control.expected)),
  })
})

type CountKey = "falseAcceptance" | "falseRejection" | "unexpectedStatuses"

const totalOf = (outcomes: ReadonlyArray<ControlOutcome>, key: CountKey) => pipe(outcomes, Array.map(Struct.get(key)), Number.sumAll)

const criteriaOf = (outcome: ControlOutcome) => Array.length(outcome.results)

const limitation = "Zero false verdicts on this finite set of constructed controls is not a universal reliability claim; the controls exercise the evaluators against a package control application, not the evaluated application."

/** Judges every constructed control with the real evaluators because the runner refuses a pass whose verifier reports a false verdict. */
const verifyRoundTrip = Effect.fn("RoundTrip.verifyRoundTrip")(function* () {
  const outcomes = yield* Effect.forEach(controls, verifyControl)
  const judgedCriteria = pipe(outcomes, Array.map(criteriaOf), Number.sumAll)

  const summary = VerifierSummary.make({
    cases: Array.length(outcomes),
    criteria: judgedCriteria,
    falseAcceptance: totalOf(outcomes, "falseAcceptance"),
    falseRejection: totalOf(outcomes, "falseRejection"),
    unexpectedStatuses: totalOf(outcomes, "unexpectedStatuses"),
  })

  return RoundTripVerifierReport.make({ evaluators: roundTripEvaluators, summary, cases: outcomes, limitation })
}, Effect.provide(controlEvaluation))

const verifierFailure = (error: Schema.SchemaError) => AcceptanceError.make({ boundary: "verifier", message: error.message })

const encodeReport = flow(Schema.encodeEffect(RoundTripVerifierReport), Effect.mapError(verifierFailure))

/** The encoded report is what run.json retains because the runner decodes only its summary counts; the controls are judged by the real evaluators. */
export const roundTripVerifier = Effect.fn("RoundTrip.verifier")(function* () {
  const report = yield* verifyRoundTrip()

  return yield* encodeReport(report)
})()
