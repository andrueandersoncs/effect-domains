import { expect, it } from "@effect/vitest"
import { Array, Effect, Function, Record, Schema, Tuple, pipe } from "effect"
import { ResultStatusSchema } from "./model.ts"
import { roundTripEvaluators, roundTripVerifier } from "./roundtrip.ts"

const JudgedSchema = Schema.Struct({ evaluator: Schema.String, status: ResultStatusSchema })

interface Judged extends Schema.Schema.Type<typeof JudgedSchema> {}

const JudgedListSchema = Schema.Array(JudgedSchema)

const JudgedControlSchema = Schema.Struct({ id: Schema.String, results: JudgedListSchema })

interface JudgedControl extends Schema.Schema.Type<typeof JudgedControlSchema> {}

const JudgedControlsSchema = Schema.Array(JudgedControlSchema)

const SummarySchema = Schema.Struct({
  cases: Schema.Int,
  criteria: Schema.Int,
  falseAcceptance: Schema.Int,
  falseRejection: Schema.Int,
  unexpectedStatuses: Schema.Int,
})

interface Summary extends Schema.Schema.Type<typeof SummarySchema> {}

// The report is decoded by its retained fields only because the runner and every consumer read the encoded verifier report.
const ReportSchema = Schema.Struct({ summary: SummarySchema, cases: JudgedControlsSchema })

interface Report extends Schema.Schema.Type<typeof ReportSchema> {}

const decodeReport = Schema.decodeUnknownEffect(ReportSchema)

const verdictEntry = (judged: Judged) => Tuple.make(judged.evaluator, judged.status)

const verdictsOf = (control: JudgedControl) => pipe(control.results, Array.map(verdictEntry), Record.fromEntries)

const controlEntry = (control: JudgedControl) => {
  const verdicts = verdictsOf(control)

  return Tuple.make(control.id, verdicts)
}

const countsOf = (summary: Summary) => [summary.cases, summary.criteria, summary.falseAcceptance, summary.falseRejection, summary.unexpectedStatuses]

const verdictTable = (report: Report) => pipe(report.cases, Array.map(controlEntry), Record.fromEntries)

const fullyPassing = { "declared-outcome": "pass", "lossless-roundtrip": "pass", "generated-excluded": "pass" }

// Each constructed control's verdicts are stated independently of the module because a verifier that grades itself proves nothing.
const expectedVerdicts = {
  "clean-accepted": { ...fullyPassing, "observation-unchanged": "fail" },
  "lossy-result": { "declared-outcome": "pass", "lossless-roundtrip": "fail" },
  "mismatched-entry": { "declared-outcome": "fail", "generated-excluded": "fail" },
  "forged-generated": { "declared-outcome": "fail", "generated-excluded": "fail" },
  "clean-rejection": { "declared-outcome": "pass", "generated-excluded": "pass", "observation-unchanged": "pass", "lossless-roundtrip": "blocked" },
  "accepted-invalid": { "declared-outcome": "fail", "observation-unchanged": "fail" },
  "rejected-with-effect": { "declared-outcome": "pass", "observation-unchanged": "fail" },
  "clean-refusal": { "declared-outcome": "pass", "observation-unchanged": "pass" },
  "wrong-refusal": { "declared-outcome": "fail" },
  "reference-retained": { "declared-outcome": "pass", "lossless-roundtrip": "pass", "observation-unchanged": "fail" },
  "reference-lost": { "lossless-roundtrip": "fail", "observation-unchanged": "pass" },
  "missing-submission": { "declared-outcome": "inconclusive", "lossless-roundtrip": "inconclusive", "generated-excluded": "inconclusive", "observation-unchanged": "inconclusive" },
  "unloaded-after": { "observation-unchanged": "inconclusive" },
}

const verifierTest = Effect.gen(function* () {
  const encoded = yield* roundTripVerifier
  const report = yield* decodeReport(encoded)
  const verdicts = verdictTable(report)
  const counts = countsOf(report.summary)

  expect(counts).toEqual([13, 31, 0, 0, 0])
  expect(verdicts).toEqual(expectedVerdicts)
  expect(roundTripEvaluators).toEqual({ "declared-outcome": "1", "lossless-roundtrip": "1", "generated-excluded": "1", "observation-unchanged": "1" })
})

it.effect("the round-trip verifier reaches the stated verdict on every constructed control with zero false verdicts", Function.constant(verifierTest))
