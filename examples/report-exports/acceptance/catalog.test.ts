import { expect, it } from "@effect/vitest"
import { Array, Effect, Function, Struct } from "effect"
import { CatalogBindings, validateCatalog } from "@effect-domains/acceptance/catalog"
import { FixtureRuntime } from "@effect-domains/acceptance/model"
import { ReportExportsApplication } from "../application.ts"
import { reportExportsCatalog } from "./catalog.ts"
import { listOperation } from "./definition.ts"
import { evaluators } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const authoredCatalogTest = Effect.gen(function* () {
  const runtime = yield* FixtureRuntime
  const bound = CatalogBindings.make({ evaluators, fixtures: runtime.bindings, actors: runtime.actors, facts: runtime.facts, probes: runtime.probes })
  const catalog = yield* validateCatalog(reportExportsCatalog, bound, ReportExportsApplication, listOperation)
  const scenarioIds = Array.map(catalog.scenarios, Struct.get("id"))

  expect(scenarioIds).toEqual(["generate-sampled-export", "reversed-period-rejected", "reader-generation-denied"])
})

const authoredCatalog = Effect.provide(authoredCatalogTest, fixtureLayer)

it.effect("the Report Exports catalog validates against the compiled application, its fixture bindings, and its evaluators", Function.constant(authoredCatalog))
