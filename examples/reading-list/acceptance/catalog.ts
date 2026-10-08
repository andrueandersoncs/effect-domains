import { Effect, Schema } from "effect"
import { ReadingListApplication } from "../application.ts"
import { AcceptanceError, CatalogSchema, type Catalog } from "./model.ts"

const provenance = "docs/wiki/story-driven-acceptance.md#slice-a-reading-list"
const revision = "1"
const approved = { revision, provenance, approval: "approved" as const }
const requirements = [
  { ...approved, id: "RL-CREATE", text: "Creating a book records exactly the submitted values under a new server-owned identity.", evaluator: "created-values", evaluatorRevision: "1", category: "behavior" as const },
  { ...approved, id: "RL-RELOAD", text: "The intended book identity and values remain visible in the loaded, unfiltered list after reload.", evaluator: "reload-visible", evaluatorRevision: "1", category: "behavior" as const },
  { ...approved, id: "RL-RATING", text: "The native contract's valid rating cases are accepted for the intended book without requiring finished status.", evaluator: "accepted-rating", evaluatorRevision: "1", category: "behavior" as const },
  { ...approved, id: "RL-REJECT", text: "A rating outside the native successful contract is rejected and leaves every book unchanged.", evaluator: "rejection-unchanged", evaluatorRevision: "1", category: "behavior" as const },
  { ...approved, id: "RL-PRESERVE", text: "The known unrelated fixture retains its identity and all values during every attempt.", evaluator: "sentinel-unchanged", evaluatorRevision: "1", category: "preservation" as const },
]
const scenarioBase = { ...approved, resource: "books", fixture: "isolated-reading-list", actor: "reader", reload: true }
const creationCases = ["sample", "null", "omitted"] as const
const ratingCases = ["minimum", "maximum", "null", "below", "above", "fractional"] as const

export const readingListCatalog: Catalog = {
  ...approved, id: "reading-list-slice-a",
  actors: [{ ...approved, id: "reader", binding: "public-reader", description: "An ordinary reader using this public local application; no authentication or inferred permissions." }],
  needs: [{ ...approved, id: "remember-books", text: "Retain books and ratings in a reading list." }],
  capabilities: [
    { ...approved, id: "record-book", resource: "books", operations: ["books.create"] },
    { ...approved, id: "rate-book", resource: "books", operations: ["books.update"] },
  ],
  textFixtures: [{ ...approved, id: "documented-book-text", provenance: "examples/reading-list/README.md#add-books-and-record-progress", values: { title: "The Dispossessed", author: "Ursula K. Le Guin" } }],
  requirements,
  stories: [
    { ...approved, id: "record-reading", original: "As a reader, I want to record a book in my reading list so that I can see it again after reloading.", actor: "reader", context: "This application is public; the reader has a book to remember.", need: "remember-books", capability: "record-book", requirements: ["RL-CREATE", "RL-RELOAD", "RL-PRESERVE"], nonGoals: ["Authentication", "Restart durability", "Discoverability"], openDecisions: [] },
    { ...approved, id: "rate-reading", original: "As a reader, I want to rate a recorded book within the native rating contract, with rejected attempts preserving all books.", actor: "reader", context: "A recorded book and an unrelated book already exist; planned status is permitted.", need: "remember-books", capability: "rate-book", requirements: ["RL-RATING", "RL-REJECT", "RL-RELOAD", "RL-PRESERVE"], nonGoals: ["Finished-status policy", "Rating history", "Authorization denial", "Concurrency"], openDecisions: [] },
  ],
  scenarios: [
    ...creationCases.map((strategy) => ({
      ...scenarioBase, id: `create-${strategy}`, story: "record-reading", operation: "books.create",
      goal: "Record the proposed book through the generated form, then reload and verify it in the unfiltered Books list. Leave the unrelated book unchanged.",
      textFixture: "documented-book-text",
      strategy, expected: "accepted" as const,
      requirements: ["RL-CREATE", "RL-RELOAD", "RL-PRESERVE"],
    })),
    ...ratingCases.map((strategy) => {
      const invalid = ["below", "above", "fractional"].includes(strategy)
      return { ...scenarioBase, id: `rating-${strategy}`, story: "rate-reading", operation: "books.update", goal: invalid ? "Attempt the proposed invalid rating for the identified target through the update form. The server must reject it. Reload and inspect the unfiltered Books list without changing either book." : "Apply the proposed valid rating to the identified planned book through the update form, then reload and inspect the unfiltered Books list. Leave the unrelated book unchanged.", strategy, expected: invalid ? "rejected" as const : "accepted" as const, requirements: invalid ? ["RL-REJECT", "RL-PRESERVE"] : ["RL-RATING", "RL-RELOAD", "RL-PRESERVE"] }
    }),
  ],
}

export const validateCatalog = Effect.fn("Acceptance.validateCatalog")(function* (input: unknown, evaluators: ReadonlyArray<string>) {
  const catalog = yield* Schema.decodeUnknownEffect(CatalogSchema)(input).pipe(Effect.mapError((error) => new AcceptanceError({ boundary: "catalog", message: String(error) })))
  const reject = (message: string) => new AcceptanceError({ boundary: "catalog", message })
  const all = [catalog, ...catalog.actors, ...catalog.needs, ...catalog.capabilities, ...catalog.textFixtures, ...catalog.requirements, ...catalog.stories, ...catalog.scenarios]
  const ids = new Set<string>()
  for (const item of all) {
    if (ids.has(item.id)) return yield* reject(`Duplicate declaration id: ${item.id}`)
    ids.add(item.id)
  }
  const operationNames = [...ReadingListApplication.group.requests.keys()]
  const hasResource = (name: string) => ReadingListApplication.resources.some((resource) => resource.name === name)
  for (const capability of catalog.capabilities) {
    if (!hasResource(capability.resource)) return yield* reject(`Missing resource ${capability.resource}`)
    for (const operation of capability.operations) if (!operationNames.includes(operation)) return yield* reject(`Missing native operation ${operation}`)
  }
  for (const requirement of catalog.requirements) {
    if (!evaluators.includes(requirement.evaluator) || requirement.evaluatorRevision !== "1") return yield* reject(`Unavailable evaluator ${requirement.evaluator}@${requirement.evaluatorRevision}`)
  }
  for (const actor of catalog.actors) if (actor.binding !== "public-reader") return yield* reject(`Missing actor binding ${actor.binding}`)
  for (const story of catalog.stories) {
    if (!catalog.actors.some((actor) => actor.id === story.actor) || !catalog.needs.some((need) => need.id === story.need) || !catalog.capabilities.some((capability) => capability.id === story.capability)) return yield* reject(`Unresolved relationships in story ${story.id}`)
    if (story.openDecisions.length) return yield* reject(`Unresolved decisions in ${story.id}: ${story.openDecisions.join(", ")}`)
    for (const requirement of story.requirements) if (!catalog.requirements.some((item) => item.id === requirement)) return yield* reject(`Missing requirement ${requirement} in ${story.id}`)
  }
  for (const scenario of catalog.scenarios) {
    const story = catalog.stories.find((item) => item.id === scenario.story)
    const capability = catalog.capabilities.find((item) => item.id === story?.capability)
    if (!story || !capability || story.actor !== scenario.actor || capability.resource !== scenario.resource || !capability.operations.includes(scenario.operation)) return yield* reject(`Incompatible story/operation/resource/actor binding in ${scenario.id}`)
    if (scenario.fixture !== "isolated-reading-list") return yield* reject(`Missing fixture binding ${scenario.fixture}`)
    if (scenario.textFixture && !catalog.textFixtures.some((fixture) => fixture.id === scenario.textFixture)) return yield* reject(`Missing text fixture ${scenario.textFixture}`)
    if (!hasResource(scenario.resource) || !operationNames.includes(scenario.operation)) return yield* reject(`Missing compiled binding in ${scenario.id}`)
    for (const id of scenario.requirements) if (!story.requirements.includes(id)) return yield* reject(`Requirement ${id} is not scoped to story ${story.id}`)
    const invalid = ["below", "above", "fractional"].includes(scenario.strategy) || scenario.strategy === "omitted" && scenario.operation === "books.update"
    if (invalid !== (scenario.expected === "rejected")) return yield* reject(`Contradictory input/outcome declaration in ${scenario.id}`)
    if ((scenario.operation === "books.update" && ["sample", "omitted"].includes(scenario.strategy)) || !["books.create", "books.update"].includes(scenario.operation)) return yield* reject(`Unsupported generated-control operation/strategy in ${scenario.id}`)
  }
  return catalog
})
