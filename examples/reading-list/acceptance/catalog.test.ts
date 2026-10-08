import { expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { readingListCatalog, validateCatalog } from "./catalog.ts"
import { evaluatorNames } from "./evaluation.ts"

it.effect("imported declarations reject missing identities and incompatible relationship bindings", () => Effect.gen(function* () {
  const changes = [
    { capabilities: [{ ...readingListCatalog.capabilities[0]!, operations: ["books.patch"] }] },
    { capabilities: [{ ...readingListCatalog.capabilities[0]!, resource: "obsolete-books" }] },
    { actors: [{ ...readingListCatalog.actors[0]!, binding: "admin-session" }] },
    { scenarios: [{ ...readingListCatalog.scenarios[0]!, operation: "books.remove" }] },
    { scenarios: [{ ...readingListCatalog.scenarios[0]!, fixture: "missing-fixture" }] },
    { scenarios: [{ ...readingListCatalog.scenarios[0]!, textFixture: "missing-text-fixture" }] },
    { scenarios: [{ ...readingListCatalog.scenarios[0]!, requirements: ["unapproved-obligation"] }] },
    { requirements: [{ ...readingListCatalog.requirements[0]!, evaluatorRevision: "obsolete" }] },
  ]
  for (const change of changes) {
    const result = yield* Effect.result(validateCatalog({ ...readingListCatalog, ...change }, evaluatorNames))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.boundary).toBe("catalog")
  }
}))

it.effect("duplicate identities and unresolved decisions prevent a contract-ready declaration", () => Effect.gen(function* () {
  for (const change of [
    { needs: [...readingListCatalog.needs, readingListCatalog.needs[0]!] },
    { stories: [{ ...readingListCatalog.stories[0]!, openDecisions: ["May we weaken rejected-attempt preservation?"] }] },
    { approval: "proposed" },
  ]) {
    const result = yield* Effect.result(validateCatalog({ ...readingListCatalog, ...change }, evaluatorNames))
    expect(Result.isFailure(result)).toBe(true)
  }
}))

it.effect("contradictory boundary outcomes and unsupported generated-control omissions remain rejected", () => Effect.gen(function* () {
  for (const scenario of [
    { ...readingListCatalog.scenarios[0]!, strategy: "below", expected: "accepted" },
    { ...readingListCatalog.scenarios[0]!, strategy: "omitted", expected: "rejected" },
  ]) {
    const result = yield* Effect.result(validateCatalog({ ...readingListCatalog, scenarios: [scenario] }, evaluatorNames))
    expect(Result.isFailure(result)).toBe(true)
  }
}))
