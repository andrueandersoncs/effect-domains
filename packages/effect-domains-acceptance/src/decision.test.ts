import { expect, it } from "@effect/vitest"
import { Array, Effect, Function } from "effect"
import { coherentAmong } from "./decision.ts"
import { Decision } from "./model.ts"

const offered = ["open:ratings.rate", "cannot-proceed"]

const coherent = coherentAmong(offered)

const decided = Decision.make({ choice: "open:ratings.rate", confidence: 0.8, probabilities: { "open:ratings.rate": 0.8, "cannot-proceed": 0.2 }, model: "jev", request: {}, response: {} })
const invented = Decision.make({ ...decided, choice: "submit:ghost" })
const partial = Decision.make({ ...decided, probabilities: { "open:ratings.rate": 1 } })
const extra = Decision.make({ ...decided, probabilities: { "open:ratings.rate": 0.7, "cannot-proceed": 0.2, "submit:ghost": 0.1 } })
const unnormalized = Decision.make({ ...decided, probabilities: { "open:ratings.rate": 0.6, "cannot-proceed": 0.2 } })
const notPeak = Decision.make({ ...decided, probabilities: { "open:ratings.rate": 0.3, "cannot-proceed": 0.7 } })

const coherenceTest = Effect.gen(function* () {
  const incoherent = [invented, partial, extra, unnormalized, notPeak]
  const accepted = coherent(decided)
  const refused = Array.map(incoherent, coherent)

  expect(accepted).toBe(true)
  expect(refused).toEqual([false, false, false, false, false])
})

it.effect("a decision is acted on only when it names an offered action with a normalized distribution peaking at the choice", Function.constant(coherenceTest))
