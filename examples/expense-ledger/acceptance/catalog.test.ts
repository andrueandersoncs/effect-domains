import { expect, it } from "@effect/vitest"
import { Array, Effect, Function, Struct } from "effect"
import { CatalogBindings, validateCatalog } from "@effect-domains/acceptance/catalog"
import { FixtureRuntime } from "@effect-domains/acceptance/model"
import { platformObligations } from "@effect-domains/acceptance/obligations"
import { roundTripEvaluators } from "@effect-domains/acceptance/roundtrip"
import { ExpenseLedgerApplication } from "../application.ts"
import { expenseLedgerCatalog } from "./catalog.ts"
import { fixtureLayer } from "./fixture.ts"

const bindings = Effect.gen(function* () {
  const runtime = yield* FixtureRuntime

  return CatalogBindings.make({ evaluators: roundTripEvaluators, fixtures: runtime.bindings, actors: runtime.actors, facts: runtime.facts, probes: runtime.probes, catalogs: [platformObligations] })
})

const authoredCatalogTest = Effect.gen(function* () {
  const bound = yield* bindings
  const { catalog, requirements } = yield* validateCatalog(expenseLedgerCatalog, bound, ExpenseLedgerApplication)
  const scenarioIds = Array.map(catalog.scenarios, Struct.get("id"))
  const evaluators = Array.map(requirements, Struct.get("evaluator"))

  expect(scenarioIds).toEqual(["record-sampled-expense", "lowercase-currency-rejected", "reversed-totals-denied"])
  expect(evaluators).toEqual(["declared-outcome", "lossless-roundtrip", "generated-excluded", "observation-unchanged"])
})

const authoredCatalog = Effect.provide(authoredCatalogTest, fixtureLayer)

it.effect("the Expense Ledger generation catalog validates against the compiled application, its fixture bindings, and the generic round-trip evaluators", Function.constant(authoredCatalog))
