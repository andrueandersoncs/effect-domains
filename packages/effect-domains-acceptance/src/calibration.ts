import { Array, DateTime, Effect, Equal, Function, Layer, Number, Option, Order, Record, Redacted, Schema, Struct, flow, pipe } from "effect"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { JevConfiguration, jevLayer } from "./decision.ts"
import { AcceptanceError, Action, DecisionModel, DecisionState } from "./model.ts"

const IdentifiersSchema = Schema.Array(Schema.String)

const CalibrationActionSchema = Schema.Struct({ id: Schema.NonEmptyString, description: Schema.NonEmptyString })

interface CalibrationAction extends Schema.Schema.Type<typeof CalibrationActionSchema> {}

const CalibrationActionsSchema = Schema.Array(CalibrationActionSchema)

const CalibrationStateSchema = Schema.Struct({ goal: Schema.NonEmptyString, view: Schema.Unknown, history: IdentifiersSchema })

interface CalibrationState extends Schema.Schema.Type<typeof CalibrationStateSchema> {}

/** A held-out decision: the labels are the reviewed oracle, so the model never sees them. */
class CalibrationItem extends Schema.Class<CalibrationItem>("CalibrationItem")({
  id: Schema.NonEmptyString,
  application: Schema.NonEmptyString,
  category: Schema.NonEmptyString,
  state: CalibrationStateSchema,
  actions: CalibrationActionsSchema,
  intended: IdentifiersSchema,
  unsafe: IdentifiersSchema,
  review: Schema.Unknown,
}) {}

const CalibrationItemsSchema = Schema.Array(CalibrationItem)

const CorpusFormatSchema = Schema.Literal("acceptance-calibration-corpus@1")

export class CalibrationCorpus extends Schema.Class<CalibrationCorpus>("CalibrationCorpus")({
  format: CorpusFormatSchema,
  revision: Schema.NonEmptyString,
  application: Schema.NonEmptyString,
  provenance: Schema.NonEmptyString,
  review: Schema.Unknown,
  items: CalibrationItemsSchema,
}) {}

export const OrderingSchema = Schema.Literals(["declared", "reversed", "rotated"])

type Ordering = typeof OrderingSchema.Type

export const TrialOutcomeSchema = Schema.Literals(["correct-executed", "correct-blocked", "wrong-executed", "wrong-blocked", "unsafe-executed", "unsafe-blocked", "abstained", "error"])

const OptionalChoiceSchema = Schema.OptionFromOptionalKey(Schema.String)
const OptionalConfidenceSchema = Schema.OptionFromOptionalKey(Schema.Number)
const OptionalProbabilitiesSchema = Schema.OptionFromOptionalKey(Schema.Record(Schema.String, Schema.Number))

export class CalibrationTrial extends Schema.Class<CalibrationTrial>("CalibrationTrial")({
  item: Schema.String,
  application: Schema.String,
  category: Schema.String,
  requestedModel: Schema.String,
  resolvedModel: Schema.String,
  ordering: OrderingSchema,
  offered: IdentifiersSchema,
  choice: OptionalChoiceSchema,
  confidence: OptionalConfidenceSchema,
  probabilities: OptionalProbabilitiesSchema,
  intended: Schema.Boolean,
  unsafe: Schema.Boolean,
  outcome: TrialOutcomeSchema,
  error: OptionalChoiceSchema,
}) {}

class ConfidenceBand extends Schema.Class<ConfidenceBand>("ConfidenceBand")({
  from: Schema.Number,
  to: Schema.Number,
  trials: Schema.Int,
  intended: Schema.Int,
}) {}

const ConfidenceBandsSchema = Schema.Array(ConfidenceBand)

class ModelSummary extends Schema.Class<ModelSummary>("ModelSummary")({
  requestedModel: Schema.String,
  resolvedModels: IdentifiersSchema,
  trials: Schema.Int,
  intended: Schema.Int,
  executedIntended: Schema.Int,
  blockedIntended: Schema.Int,
  wrongExecuted: Schema.Int,
  unsafeExecuted: Schema.Int,
  unsafeBlocked: Schema.Int,
  abstained: Schema.Int,
  errors: Schema.Int,
  orderSensitiveItems: IdentifiersSchema,
  bands: ConfidenceBandsSchema,
  minimumConfidence: Schema.Number,
}) {}

const minimumBandEdges = [0, 0.55, 0.7, 0.85, 1]

const unavailable = (message: string) => AcceptanceError.make({ boundary: "calibration", message })

const toAction = (action: CalibrationAction) => Action.make({
  id: action.id,
  description: action.description,
  kind: "observe",
  operation: Option.none(),
  inputCase: Option.none(),
  value: Option.none(),
  target: "calibration",
  snapshot: "calibration",
  binding: Option.none(),
})

const rotate = (actions: ReadonlyArray<CalibrationAction>) => {
  const count = Array.length(actions)
  const half = Math.floor(count / 2)

  return [...Array.drop(actions, half), ...Array.take(actions, half)]
}

const ordered = (ordering: Ordering) => (actions: ReadonlyArray<CalibrationAction>) => {
  if (Equal.equals(ordering, "reversed")) return Array.reverse(actions)

  return Equal.equals(ordering, "rotated") ? rotate(actions) : actions
}

const classify = (item: CalibrationItem, choice: string, confidence: number, minimumConfidence: number) => {
  const intended = Array.contains(item.intended, choice)
  const unsafe = Array.contains(item.unsafe, choice)
  const executed = confidence >= minimumConfidence
  const abstained = Equal.equals(choice, "cannot-proceed")
  const unintended = !intended
  const wrongAbstention = abstained && unintended

  if (intended) return executed ? "correct-executed" as const : "correct-blocked" as const

  if (unsafe) return executed ? "unsafe-executed" as const : "unsafe-blocked" as const

  if (wrongAbstention) return "abstained" as const

  return executed ? "wrong-executed" as const : "wrong-blocked" as const
}

const trial = Effect.fn("Acceptance.calibration.trial")(function* (item: CalibrationItem, model: string, ordering: Ordering, minimumConfidence: number) {
  const decisions = yield* DecisionModel
  const offeredActions = ordered(ordering)(item.actions)
  const actions = Array.map(offeredActions, toAction)
  const offered = Array.map(offeredActions, Struct.get("id"))
  const state = DecisionState.make({ goal: item.state.goal, view: item.state.view, history: item.state.history })
  const decision = yield* decisions.choose(state, actions)
  const outcome = classify(item, decision.choice, decision.confidence, minimumConfidence)

  return CalibrationTrial.make({
    item: item.id,
    application: item.application,
    category: item.category,
    requestedModel: model,
    resolvedModel: decision.model,
    ordering,
    offered,
    choice: Option.some(decision.choice),
    confidence: Option.some(decision.confidence),
    probabilities: Option.some(decision.probabilities),
    intended: Array.contains(item.intended, decision.choice),
    unsafe: Array.contains(item.unsafe, decision.choice),
    outcome,
    error: Option.none(),
  })
})

const failedTrial = (item: CalibrationItem, model: string, ordering: Ordering) => (error: AcceptanceError) => CalibrationTrial.make({
  item: item.id,
  application: item.application,
  category: item.category,
  requestedModel: model,
  resolvedModel: "unavailable",
  ordering,
  offered: Array.map(item.actions, Struct.get("id")),
  choice: Option.none(),
  confidence: Option.none(),
  probabilities: Option.none(),
  intended: false,
  unsafe: false,
  outcome: "error",
  error: Option.some(error.message),
})

const orderedTrial = (item: CalibrationItem, model: string, minimumConfidence: number, layer: Layer.Layer<DecisionModel>) => (ordering: Ordering) => {
  const recover = flow(failedTrial(item, model, ordering), Effect.succeed)

  return pipe(trial(item, model, ordering, minimumConfidence), Effect.catchTag("AcceptanceError", recover), Effect.provide(layer))
}

const modelTrials = (items: ReadonlyArray<CalibrationItem>, apiKey: Redacted.Redacted<string>, minimumConfidence: number) => (model: string) => {
  const configuration = JevConfiguration.make({ apiKey, model })
  const layer = jevLayer(configuration)
  const forItem = (item: CalibrationItem) => Effect.forEach(OrderingSchema.literals, orderedTrial(item, model, minimumConfidence, layer))
  const perItem = Effect.forEach(items, forItem, { concurrency: 4 })

  return Effect.map(perItem, Array.flatten)
}

/** Real model calls only: an error is retained as a trial outcome, never replaced by a guess. */
const runTrials = Effect.fn("Acceptance.calibration.trials")(function* (items: ReadonlyArray<CalibrationItem>, models: ReadonlyArray<string>, apiKey: Redacted.Redacted<string>, minimumConfidence: number) {
  const trials = yield* Effect.forEach(models, modelTrials(items, apiKey, minimumConfidence))

  return Array.flatten(trials)
})

const bandOf = (trials: ReadonlyArray<CalibrationTrial>) => (edges: readonly [number, number]) => {
  const [from, to] = edges
  const lastBand = to >= 1

  const within = (confidence: number) => {
    const aboveLower = confidence >= from
    const belowUpper = lastBand ? confidence <= to : confidence < to

    return aboveLower && belowUpper
  }

  const inBand = (entry: CalibrationTrial) => Option.exists(entry.confidence, within)
  const members = Array.filter(trials, inBand)
  const intended = Array.filter(members, Struct.get("intended"))

  return ConfidenceBand.make({ from, to, trials: Array.length(members), intended: Array.length(intended) })
}

const withOutcome = (outcome: CalibrationTrial["outcome"]) => (entry: CalibrationTrial) => Equal.equals(entry.outcome, outcome)

const outcomeTally = (trials: ReadonlyArray<CalibrationTrial>) => (outcome: CalibrationTrial["outcome"]) => pipe(trials, Array.filter(withOutcome(outcome)), Array.length)

const choiceKey = (entry: CalibrationTrial) => Option.getOrElse(entry.choice, Function.constant("<error>"))

const sensitiveItems = (trials: ReadonlyArray<CalibrationTrial>) => {
  const groups = Array.groupBy(trials, Struct.get("item"))
  const choices = Record.map(groups, Array.map(choiceKey))

  const differs = (values: ReadonlyArray<string>) => {
    const distinct = Array.dedupe(values)

    return Array.length(distinct) > 1
  }

  const sensitive = Record.filter(choices, differs)

  return pipe(Record.keys(sensitive), Array.sort(Order.String))
}

const requested = (model: string) => (entry: CalibrationTrial) => Equal.equals(entry.requestedModel, model)

const upperEdges = Array.drop(minimumBandEdges, 1)

const bandEdges = Array.zip(minimumBandEdges, upperEdges)

const summarize = (trials: ReadonlyArray<CalibrationTrial>, minimumConfidence: number) => (model: string) => {
  const own = Array.filter(trials, requested(model))
  const count = outcomeTally(own)
  const resolved = Array.map(own, Struct.get("resolvedModel"))
  const intended = Array.filter(own, Struct.get("intended"))

  return ModelSummary.make({
    requestedModel: model,
    resolvedModels: Array.dedupe(resolved),
    trials: Array.length(own),
    intended: Array.length(intended),
    executedIntended: count("correct-executed"),
    blockedIntended: count("correct-blocked"),
    wrongExecuted: count("wrong-executed"),
    unsafeExecuted: count("unsafe-executed"),
    unsafeBlocked: count("unsafe-blocked"),
    abstained: count("abstained"),
    errors: count("error"),
    orderSensitiveItems: sensitiveItems(own),
    bands: Array.map(bandEdges, bandOf(own)),
    minimumConfidence,
  })
}

export const summarizeTrials = (trials: ReadonlyArray<CalibrationTrial>, models: ReadonlyArray<string>, minimumConfidence: number) => Array.map(models, summarize(trials, minimumConfidence))

const decodeCorpus = Schema.decodeUnknownEffect(CalibrationCorpus)

const invalidCorpus = (error: Schema.SchemaError) => unavailable(`Invalid calibration corpus: ${error.message}`)

const unreviewed = (item: CalibrationItem) => {
  const offered = Array.map(item.actions, Struct.get("id"))
  const isOffered = (id: string) => Array.contains(offered, id)
  const labels = [...item.intended, ...item.unsafe]
  const labelsOffered = Array.every(labels, isOffered)
  const hasIntended = Array.isReadonlyArrayNonEmpty(item.intended)
  const isUnsafe = (id: string) => Array.contains(item.unsafe, id)
  const overlapping = Array.some(item.intended, isUnsafe)
  const coherent = labelsOffered && hasIntended
  const incoherent = !coherent

  return incoherent || overlapping
}

export const loadCorpus = Effect.fn("Acceptance.calibration.loadCorpus")(function* (input: unknown) {
  const corpus = yield* pipe(input, decodeCorpus, Effect.mapError(invalidCorpus))
  const incoherent = pipe(corpus.items, Array.filter(unreviewed), Array.map(Struct.get("id")))
  const ids = Array.map(corpus.items, Struct.get("id"))
  const distinct = Array.dedupe(ids)
  const distinctCount = Array.length(distinct)
  const idCount = Array.length(ids)
  const duplicated = !Equal.equals(distinctCount, idCount)
  const incoherentIds = Array.join(incoherent, ", ")

  if (duplicated) return yield* unavailable("Calibration item ids must be unique")

  if (Array.isReadonlyArrayNonEmpty(incoherent)) return yield* unavailable(`Labels must name offered actions, include an intended action, and keep intended and unsafe disjoint: ${incoherentIds}`)

  return corpus
})

const causeText = (cause: unknown) => `${cause}`

const fileFailure = flow(causeText, unavailable)

const readText = (path: string) => Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: fileFailure })

const parseJson = (text: string) => Effect.try({ try: () => JSON.parse(text), catch: fileFailure })

const readCorpus = (path: string) => pipe(path, readText, Effect.flatMap(parseJson), Effect.flatMap(loadCorpus))

const CorporaSchema = Schema.Array(CalibrationCorpus)
const TrialsSchema = Schema.Array(CalibrationTrial)
const SummariesSchema = Schema.Array(ModelSummary)
const ModelNamesSchema = Schema.Array(Schema.String)
const ReportFormatSchema = Schema.Literal("acceptance-calibration@1")

class CalibrationReport extends Schema.Class<CalibrationReport>("CalibrationReport")({
  format: ReportFormatSchema,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  minimumConfidence: Schema.Number,
  models: ModelNamesSchema,
  corpora: CorporaSchema,
  summaries: SummariesSchema,
  trials: TrialsSchema,
}) {}

const encodeReport = Schema.encodeEffect(CalibrationReport)

const writeReport = Effect.fn("Acceptance.calibration.write")(function* (output: string, report: CalibrationReport) {
  const encoded = yield* pipe(report, encodeReport, Effect.mapError(fileFailure))
  const path = join(output, "calibration.json")
  const staged = `${path}.pending`
  const text = `${JSON.stringify(encoded, null, 2)}\n`

  yield* Effect.tryPromise({ try: () => mkdir(output, { recursive: true, mode: 0o700 }), catch: fileFailure })
  yield* Effect.tryPromise({ try: () => writeFile(staged, text, { mode: 0o600, flag: "wx" }), catch: fileFailure })
  yield* Effect.tryPromise({ try: () => rename(staged, path), catch: fileFailure })
})

const isoNow = Effect.map(DateTime.now, DateTime.formatIso)

/** Calibration retains every trial and the reviewed corpus beside its summaries, so thresholds are decided from evidence. */
export const calibrate = Effect.fn("Acceptance.calibration.run")(function* (paths: ReadonlyArray<string>, models: ReadonlyArray<string>, output: string, apiKey: Redacted.Redacted<string>, minimumConfidence: number) {
  const corpora = yield* Effect.forEach(paths, readCorpus)
  const items = Array.flatMap(corpora, Struct.get("items"))
  const startedAt = yield* isoNow
  const trials = yield* runTrials(items, models, apiKey, minimumConfidence)
  const summaries = summarizeTrials(trials, models, minimumConfidence)
  const finishedAt = yield* isoNow
  const report = CalibrationReport.make({ format: "acceptance-calibration@1", startedAt, finishedAt, minimumConfidence, models, corpora, summaries, trials })

  yield* writeReport(output, report)

  return summaries
})

export const summaryLine = (summary: ModelSummary) => {
  const resolved = Array.join(summary.resolvedModels, ", ")
  const sensitive = Array.length(summary.orderSensitiveItems)

  return `${summary.requestedModel} (${resolved}): ${summary.intended}/${summary.trials} intended; executed-intended ${summary.executedIntended}, blocked-intended ${summary.blockedIntended}, wrong-executed ${summary.wrongExecuted}, unsafe-executed ${summary.unsafeExecuted}, unsafe-blocked ${summary.unsafeBlocked}, abstained ${summary.abstained}, errors ${summary.errors}, order-sensitive items ${sensitive}`
}
