import { expect, it } from "@effect/vitest"
import { Array, Effect, Function, Option, Schema, String as Text, pipe } from "effect"
import { Action, PayloadSchema, Scenario } from "./model.ts"
import { type SurfaceBinding, type SurfaceDeclaration, repairMatch, rowTarget, targetText, validateSurfaces } from "./surface.ts"
import { TestApplication } from "./test-application.ts"

const scenarioDeclaration: typeof Scenario.Encoded = {
  id: "rate-row",
  revision: "1",
  provenance: "test",
  approval: "approved",
  story: "rate",
  actor: "operator",
  fixture: "rows",
  goal: "Rate the prepared row",
  operations: ["ratings.rate"],
  inputs: [
    {
      id: "rate",
      operation: "ratings.rate",
      description: "Rate the prepared row",
      fields: { note: { source: "fixture", fact: "row.id", offset: 0 }, score: { source: "literal", value: 4 }, rating: { source: "native", strategy: "sample" } },
      validity: "native-valid",
      outcome: { kind: "accepted" },
    },
  ],
  required: ["rate"],
  observations: [],
  probes: [],
  requirements: [],
  assessments: [],
  reload: false,
}

const rateAction: SurfaceDeclaration["actions"][number] = {
  id: "rate",
  operation: "ratings.rate",
  description: "Rate this row",
  trigger: { locator: ".rate", semantics: { role: "button", name: "Rate", attributes: { "data-operation": "ratings.rate" } } },
  controls: [{ name: "rating", kind: "text", element: { locator: ".rating", semantics: { role: "textbox", name: "Rating", attributes: {} } } }],
  fields: { note: { from: "identity" }, score: { from: "literal", value: 4 }, rating: { from: "control", name: "rating" } },
  settle: "main[data-state='ready']",
}

const declaration: SurfaceDeclaration = {
  id: "ratings-desk",
  title: "Ratings desk",
  path: "/ratings",
  ready: "main[data-state='ready']",
  source: "ratings.rate",
  refresh: { locator: ".refresh", semantics: { role: "button", name: "Refresh", attributes: {} } },
  collection: {
    row: { locator: "tr.rating-row", semantics: { role: "row", attributes: {} } },
    identity: "data-id",
    identityColumn: "id",
    columns: [{ column: "id", locator: "[data-column='id']", attribute: "data-value" }],
  },
  actions: [rateAction],
  scenarios: ["rate-row"],
  presentation: ["ratings.ts"],
}

const renamed: SurfaceDeclaration = {
  ...declaration,
  collection: { ...declaration.collection, row: { ...declaration.collection.row, locator: "tr.queue-item" } },
  actions: [{ ...rateAction, trigger: { ...rateAction.trigger, locator: ".queue-rate" } }],
}

const decodeScenario = Schema.decodeUnknownEffect(Scenario)

const validated = Effect.fn("SurfaceTest.validated")(function* (declarations: ReadonlyArray<SurfaceDeclaration>) {
  const scenario = yield* decodeScenario(scenarioDeclaration)

  return yield* validateSurfaces(declarations, [scenario], TestApplication)
})

const rejection = Effect.fn("SurfaceTest.rejection")(function* (declarations: ReadonlyArray<SurfaceDeclaration>) {
  const validation = validated(declarations)
  const error = yield* Effect.flip(validation)

  return error.message
})

const payload = (note: string) => PayloadSchema.make({ note, score: 4, rating: 5 })

const first = <A>(values: ReadonlyArray<A>) => pipe(values, Array.head, Effect.fromOption)

const offeredFrom = (surface: SurfaceBinding, action: SurfaceBinding["actions"][number]) => (note: string) => {
  const target = rowTarget(surface, action)
  const value = payload(note)

  return Action.make({
    id: "surface:ratings-desk:rate:rate",
    description: "Rate this row",
    kind: "submit",
    operation: Option.some("ratings.rate"),
    inputCase: Option.some("rate"),
    value: Option.some(value),
    target: targetText(target, surface.path),
    binding: Option.some(target),
    snapshot: "snapshot",
  })
}

const offerOf = Effect.fn("SurfaceTest.offerOf")(function* (declarations: ReadonlyArray<SurfaceDeclaration>) {
  const surfaces = yield* validated(declarations)
  const surface = yield* first(surfaces)
  const action = yield* first(surface.actions)

  return offeredFrom(surface, action)
})

const bindings = Effect.fn("SurfaceTest.bindings")(function* () {
  const recorded = yield* offerOf([declaration])
  const current = yield* offerOf([renamed])

  return { recorded, current }
})

const acceptsBindingTest = Effect.gen(function* () {
  const surfaces = yield* validated([declaration])
  const surface = yield* first(surfaces)
  const action = yield* first(surface.actions)

  expect(surface.id).toBe("ratings-desk")
  expect(action.fields.note?.from).toBe("identity")
})

const unknownOperation: SurfaceDeclaration = { ...declaration, actions: [{ ...rateAction, operation: "ratings.missing" }] }

const doubleIdentity: SurfaceDeclaration = { ...declaration, actions: [{ ...rateAction, fields: { ...rateAction.fields, score: { from: "identity" } } }] }

const undeclaredControl: SurfaceDeclaration = { ...declaration, actions: [{ ...rateAction, fields: { ...rateAction.fields, rating: { from: "control", name: "stars" } } }] }

const unknownScenario: SurfaceDeclaration = { ...declaration, scenarios: ["rate-row", "missing-scenario"] }

const uncovered: SurfaceDeclaration = { ...declaration, actions: [{ ...rateAction, controls: [], fields: { note: { from: "identity" }, score: { from: "literal", value: 4 } } }] }

const conflictingLiteral: SurfaceDeclaration = { ...declaration, actions: [{ ...rateAction, fields: { ...rateAction.fields, score: { from: "literal", value: 3 } } }] }

const rejectsBindingsTest = Effect.gen(function* () {
  const operation = yield* rejection([unknownOperation])
  const identity = yield* rejection([doubleIdentity])
  const control = yield* rejection([undeclaredControl])
  const scenario = yield* rejection([unknownScenario])
  const coverage = yield* rejection([uncovered])
  const literal = yield* rejection([conflictingLiteral])
  const duplicated = yield* rejection([declaration, declaration])

  expect(operation).toContain("binds unknown native operation ratings.missing")
  expect(identity).toContain("must bind exactly one input field to the row identity")
  expect(control).toContain("references undeclared control stars")
  expect(scenario).toContain("binds unknown scenario missing-scenario")
  expect(coverage).toContain("has no action whose fields and literals cover a required input of rate-row: rate")
  expect(literal).toContain("has no action whose fields and literals cover a required input of rate-row: rate")
  expect(duplicated).toContain("Duplicate custom surface id ratings-desk")
})

const repairsUniqueMatchTest = Effect.gen(function* () {
  const { recorded, current } = yield* bindings()
  const before = recorded("row-1")
  const after = current("row-1")
  const other = current("row-2")
  const match = yield* repairMatch(before, [other, after])
  const renamedRow = Text.includes("tr.queue-item")(match.target)

  expect(match.target).toBe(after.target)
  expect(renamedRow).toBe(true)
})

const refusal = Effect.fn("SurfaceTest.refusal")(function* (recorded: Action, options: ReadonlyArray<Action>) {
  const attempt = repairMatch(recorded, options)
  const error = yield* Effect.flip(attempt)

  return error.message
})

const refusesRepairTest = Effect.gen(function* () {
  const { recorded, current } = yield* bindings()
  const before = recorded("row-1")
  const after = current("row-1")
  const mismatched = current("row-2")
  const generated = Action.make({ ...before, binding: Option.none() })
  const ambiguous = yield* refusal(before, [after, after])
  const none = yield* refusal(before, [])
  const mismatch = yield* refusal(before, [mismatched])
  const unchanged = yield* refusal(before, [before])
  const uncustom = yield* refusal(generated, [after])

  expect(ambiguous).toContain("an ambiguous repair is refused")
  expect(none).toContain("a semantic mismatch is never repaired")
  expect(mismatch).toContain("a semantic mismatch is never repaired")
  expect(unchanged).toContain("are unchanged")
  expect(uncustom).toContain("Only actions offered through a declared custom-UI binding")
})

it.effect("accepts a complete custom surface binding", Function.constant(acceptsBindingTest))

it.effect("rejects unknown operations, ambiguous identities, undeclared controls, unknown scenarios, uncovered inputs, and duplicates", Function.constant(rejectsBindingsTest))

it.effect("repairs only onto the single offered action with the recorded semantic target", Function.constant(repairsUniqueMatchTest))

it.effect("refuses ambiguous, absent, mismatched, unchanged, and non-custom repairs", Function.constant(refusesRepairTest))
