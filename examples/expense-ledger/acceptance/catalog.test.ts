import { expect, it } from "@effect/vitest"
import { Array, Effect, Function, Struct } from "effect"
import { CatalogBindings, validateCatalog } from "@effect-domains/acceptance/catalog"
import { FixtureRuntime } from "@effect-domains/acceptance/model"
import { ExpenseLedgerApplication } from "../application.ts"
import { expenseLedgerCatalog, listOperation } from "./catalog.ts"
import { evaluators } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const authoredCatalogTest = Effect.gen(function* () {
  const runtime = yield* FixtureRuntime
  const bound = CatalogBindings.make({ evaluators, fixtures: runtime.bindings, actors: runtime.actors, facts: runtime.facts, probes: runtime.probes })
  const catalog = yield* validateCatalog(expenseLedgerCatalog, bound, ExpenseLedgerApplication, listOperation)
  const scenarioIds = Array.map(catalog.scenarios, Struct.get("id"))
  const evaluatorNames = Array.map(catalog.requirements, Struct.get("evaluator"))

  expect(scenarioIds).toEqual(["record-sampled-expense", "lowercase-currency-rejected", "reversed-totals-denied"])
  expect(evaluatorNames).toEqual(["declared-outcome", "recorded-echo", "observation-unchanged"])
})

const authoredCatalog = Effect.provide(authoredCatalogTest, fixtureLayer)

it.effect("the Expense Ledger generation catalog validates against the compiled application, its fixture bindings, and its evaluators", Function.constant(authoredCatalog))
