import { expect, it } from "@effect/vitest"
import { Array, Effect, Function, Option, Schema, Struct, pipe } from "effect"
import { CalibrationCorpus, CalibrationTrial, loadCorpus, summarizeTrials } from "./calibration.ts"

const trialOf = (item: string, ordering: "declared" | "reversed" | "rotated", choice: string, confidence: number, outcome: CalibrationTrial["outcome"]) => CalibrationTrial.make({
  item,
  application: "test",
  category: "test",
  requestedModel: "model-a",
  resolvedModel: "model-a@1",
  ordering,
  offered: ["advance", "cannot-proceed"],
  choice: Option.some(choice),
  confidence: Option.some(confidence),
  probabilities: Option.none(),
  intended: Array.contains(["correct-executed", "correct-blocked"], outcome),
  unsafe: Array.contains(["unsafe-executed", "unsafe-blocked"], outcome),
  outcome,
  error: Option.none(),
})

const trials = [
  trialOf("first", "declared", "advance", 1, "correct-executed"),
  trialOf("first", "reversed", "advance", 0.55, "correct-executed"),
  trialOf("first", "rotated", "cannot-proceed", 0.54, "abstained"),
  trialOf("second", "declared", "advance", 0.7, "unsafe-executed"),
  trialOf("second", "reversed", "advance", 0.2, "unsafe-blocked"),
  trialOf("second", "rotated", "advance", 0.85, "wrong-executed"),
]

const summaryTest = Effect.gen(function* () {
  const summary = yield* pipe(summarizeTrials(trials, ["model-a"], 0.55), Array.head, Effect.fromOption)
  const bandTrials = Array.map(summary.bands, Struct.get("trials"))
  const bandIntended = Array.map(summary.bands, Struct.get("intended"))

  expect(bandTrials).toEqual([2, 1, 1, 2])
  expect(bandIntended).toEqual([0, 1, 0, 1])
  expect(summary.executedIntended).toBe(2)
  expect(summary.unsafeExecuted).toBe(1)
  expect(summary.unsafeBlocked).toBe(1)
  expect(summary.wrongExecuted).toBe(1)
  expect(summary.abstained).toBe(1)
  expect(summary.orderSensitiveItems).toEqual(["first"])
})

const EncodedCorpusSchema = Schema.toEncoded(CalibrationCorpus)

const corpus = (unsafe: ReadonlyArray<string>) => EncodedCorpusSchema.make({
  format: "acceptance-calibration-corpus@1",
  revision: "1",
  application: "test",
  provenance: "test",
  review: null,
  items: [{ id: "only", application: "test", category: "test", state: { goal: "Advance", view: null, history: [] }, actions: [{ id: "advance", description: "Advance" }], intended: ["advance"], unsafe, review: null }],
})

const validCorpus = corpus([])
const unofferedCorpus = corpus(["delete-everything"])
const overlappingCorpus = corpus(["advance"])

const corpusTest = Effect.gen(function* () {
  const valid = yield* loadCorpus(validCorpus)
  const unoffered = yield* pipe(unofferedCorpus, loadCorpus, Effect.flip)
  const overlapping = yield* pipe(overlappingCorpus, loadCorpus, Effect.flip)
  const itemCount = Array.length(valid.items)

  expect(itemCount).toBe(1)
  expect(unoffered.boundary).toBe("calibration")
  expect(overlapping.boundary).toBe("calibration")
})

it.effect("summaries band every confidence including the boundaries and tally outcomes and order sensitivity", Function.constant(summaryTest))
it.effect("corpus labels must name offered actions and keep intended and unsafe disjoint", Function.constant(corpusTest))
