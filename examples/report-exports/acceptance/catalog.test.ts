import { expect, it } from "@effect/vitest"
import { Array, Effect, Function, Option, Struct, flow, pipe } from "effect"
import { CatalogBindings, validateCatalog } from "@effect-domains/acceptance/catalog"
import { FixtureRuntime } from "@effect-domains/acceptance/model"
import { platformObligations } from "@effect-domains/acceptance/obligations"
import { ReportExportsApplication } from "../application.ts"
import { reportExportsCatalog } from "./catalog.ts"
import { evaluatorRevisions } from "./evaluation.ts"
import { fixtureLayer } from "./fixture.ts"

const bindings = Effect.gen(function* () {
  const runtime = yield* FixtureRuntime

  return CatalogBindings.make({ evaluators: evaluatorRevisions, fixtures: runtime.bindings, actors: runtime.actors, facts: runtime.facts, probes: runtime.probes, catalogs: [platformObligations] })
})

const authoredCatalogTest = Effect.gen(function* () {
  const bound = yield* bindings
  const { catalog, requirements } = yield* validateCatalog(reportExportsCatalog, bound, ReportExportsApplication)
  const scenarioIds = Array.map(catalog.scenarios, Struct.get("id"))
  const evaluators = Array.map(requirements, Struct.get("evaluator"))
  const watched = pipe(catalog.scenarios, Array.flatMap(flow(Struct.get("watch"), Option.toArray)), Array.map(Struct.get("probe")))

  expect(scenarioIds).toEqual(["generate-sampled-export", "reversed-period-rejected", "reader-generation-denied", "generate-export-completes"])
  expect(evaluators).toEqual(["declared-outcome", "lossless-roundtrip", "generated-excluded", "observation-unchanged", "eventual-completion"])
  expect(watched).toEqual(["export-status"])
})

const authoredCatalog = Effect.provide(authoredCatalogTest, fixtureLayer)

it.effect("the Report Exports generation catalog validates against the compiled application, its fixture bindings, and the generic round-trip and eventual-completion evaluators", Function.constant(authoredCatalog))
