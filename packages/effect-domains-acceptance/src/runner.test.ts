import { expect, it } from "@effect/vitest"
import { Effect, Function, Option, Schema, pipe } from "effect"
import { BuildIdentity, Catalog, Decision } from "./model.ts"
import { type AcceptanceDefinition, confidenceGate, validateDefinition, validateReplay } from "./runner.ts"
import { TestApplication, listOperation } from "./test-application.ts"

const scenario = {
  id: "scenario",
  story: "story",
  actor: "person",
  fixture: "fixture-a",
  goal: "Rate the book.",
  operations: ["ratings.rate"],
  inputs: [],
  required: [],
  observations: [],
  probes: [],
  requirements: ["REQ-CHECK"],
  reload: false,
}

const declared = {
  id: "tiny",
  actors: [{ id: "person", binding: "public", description: "An ordinary person." }],
  requirements: [{ id: "REQ-CHECK", text: "The rating holds.", evaluator: "check" }],
  stories: [{ id: "story", text: "As a person, I want to rate a book.", actor: "person", requirements: ["REQ-CHECK"] }],
  scenarios: [scenario],
}

const build = BuildIdentity.make({
  application: "acceptance-test",
  sourceHash: "source",
  bundleHash: "bundle",
  files: [],
  catalogHash: "catalog",
  nativeContractsHash: "contracts",
  nativeContracts: {},
  effect: "4.0.0-rc.112",
  bun: "1",
})

const recordedBuild = { sourceHash: "source", bundleHash: "bundle", catalogHash: "catalog", nativeContractsHash: "contracts" }

const recording = { application: "acceptance-test", build: recordedBuild, scenarios: [{ scenario, candidates: [], trace: [] }] }

const decodeCatalog = Schema.decodeUnknownEffect(Catalog)

const replayFailure = (catalog: Catalog) => (content: unknown) => pipe(content, validateReplay("acceptance-test", build, catalog), Effect.flip)

const staleness = Effect.gen(function* () {
  const catalog = yield* decodeCatalog(declared)
  const fresh = yield* validateReplay("acceptance-test", build, catalog)(recording)
  const rejected = replayFailure(catalog)
  const sourceChanged = yield* rejected({ ...recording, build: { ...recordedBuild, sourceHash: "edited" } })
  const bundleChanged = yield* rejected({ ...recording, build: { ...recordedBuild, bundleHash: "rebuilt" } })
  const catalogChanged = yield* rejected({ ...recording, build: { ...recordedBuild, catalogHash: "edited" } })
  const contractsChanged = yield* rejected({ ...recording, build: { ...recordedBuild, nativeContractsHash: "edited" } })
  const otherApplication = yield* rejected({ ...recording, application: "other" })
  const uncovered = yield* rejected({ ...recording, scenarios: [] })
  const undecodable = yield* rejected({ application: "acceptance-test" })

  expect(fresh.scenarios).toHaveLength(1)
  expect(sourceChanged.boundary).toBe("replay")
  expect(sourceChanged.message).toContain("Replay is stale")
  expect(bundleChanged.message).toContain("Replay is stale")
  expect(catalogChanged.message).toContain("Replay is stale")
  expect(contractsChanged.message).toContain("Replay is stale")
  expect(otherApplication.message).toBe("Replay records other, not acceptance-test")
  expect(uncovered.message).toBe("Replay lacks exact scenario coverage")
  expect(undecodable.boundary).toBe("replay")
})

const decided = (confidence: number) => Decision.make({ choice: "submit:rate", confidence, probabilities: { "submit:rate": confidence }, model: "jev", request: {}, response: {} })

const gate = Effect.gen(function* () {
  const unsure = decided(0.4)
  const sure = decided(0.55)
  const unsureDecision = Option.some(unsure)
  const sureDecision = Option.some(sure)
  const replayed = Option.none<Decision>()
  const refused = yield* pipe(confidenceGate(0.55, unsureDecision), Effect.flip)

  yield* confidenceGate(0.55, sureDecision)
  yield* confidenceGate(0.55, replayed)

  expect(refused.boundary).toBe("decision")
  expect(refused.message).toBe("Confidence 0.4 is below configured 0.55; action not executed")
})

const definition: AcceptanceDefinition = {
  name: "acceptance-test",
  title: "Acceptance test",
  catalog: declared,
  application: TestApplication,
  evaluators: ["check"],
  observationOperation: listOperation,
  submissionProbes: ["status"],
  directProbes: ["ratings.rate"],
  defaultMaxActions: 10,
}

const misprobed: AcceptanceDefinition = { ...definition, submissionProbes: ["status", "telepathy"], directProbes: ["ratings.erase"] }

const definitionProbes = Effect.gen(function* () {
  yield* validateDefinition(definition, ["status"])

  const refused = yield* pipe(validateDefinition(misprobed, ["status"]), Effect.flip)

  expect(refused.boundary).toBe("definition")
  expect(refused.message).toBe("Submission probe telepathy is not implemented by the fixture runtime; Direct probe ratings.erase is not a native operation of acceptance-test")
})

it.effect("a replay is refused for another application, a changed source, bundle, catalog, or native contract, or inexact scenario coverage", Function.constant(staleness))
it.effect("the confidence gate refuses a model decision below the configured minimum and admits replayed choices", Function.constant(gate))
it.effect("unknown submission probes and direct-probe operations are rejected before execution", Function.constant(definitionProbes))
