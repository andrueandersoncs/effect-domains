import { expect, it } from "@effect/vitest"
import { Array, Effect, Function, Option, Schema, String as Text, Struct, pipe } from "effect"
import { Application, Part } from "effect-domains/application"
import { Command } from "effect-domains/command"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { BoundRequirement, Catalog } from "./model.ts"
import { platformObligations } from "./obligations.ts"
import { scopedTemporaryDirectory } from "./server.ts"
import { TestApplication } from "./test-application.ts"

import {
  CurrentBuild,
  ImportedCatalog,
  Product,
  RetainedRun,
  documentationView,
  gapView,
  impactCaveat,
  impactView,
  implementationView,
  nativeFieldsOf,
  notAssessed,
  qaView,
  readEvidence,
  requirementView,
  type OperationEntry,
  type QaScenario,
  type ScopeEvidence,
} from "./query.ts"

const DeclarationSchema = Schema.toEncoded(Catalog)
const RunSchema = Schema.toEncoded(RetainedRun)
const revision = "1"
const provenance = "query test"
const approval = "approved"
const currentBuild = "c".repeat(64)
const oldBuild = "0".repeat(64)
const catalogHash = "h".repeat(64)
const assertion = "executable assertion"

type ScenarioDeclaration = typeof Catalog.Encoded["scenarios"][number]

const requirement = (id: string): typeof Catalog.Encoded["requirements"][number] => ({ id, revision, provenance, approval, text: `${id} holds.`, evaluator: "check", evaluatorRevision: revision, category: "behavior", parameters: [] })

const preserve: typeof Catalog.Encoded["requirements"][number] = {
  id: "REQ-PRESERVE",
  revision,
  provenance,
  approval,
  text: "Other records stay unchanged.",
  evaluator: "check",
  evaluatorRevision: revision,
  category: "preservation",
  parameters: [],
  refines: { requirement: "platform:PLATFORM-PRESERVE", arguments: { scope: "the other records" } },
}

const scenario = (id: string, assessments: ReadonlyArray<string>): ScenarioDeclaration => ({
  id,
  revision,
  provenance,
  approval,
  story: "story",
  actor: "person",
  fixture: "fixture",
  goal: `Reach the ${id} outcome.`,
  operations: ["ratings.rate"],
  inputs: [{ id: "sample", operation: "ratings.rate", description: "A native sample rating", fields: { rating: { source: "native", strategy: "sample" } }, validity: "native-valid", outcome: { kind: "accepted" } }],
  required: ["sample"],
  observations: [],
  probes: [],
  requirements: ["REQ-CHECK", "REQ-PRESERVE"],
  assessments,
  reload: false,
})

const clarity: typeof Catalog.Encoded["rubrics"][number] = {
  id: "clarity",
  revision,
  provenance,
  approval: "proposed",
  criteria: ["Says what happened to the rating"],
  scale: [{ level: "unclear", meaning: "The reader cannot tell what happened." }, { level: "clear", meaning: "The reader can tell what happened." }],
  threshold: "clear",
  reviewer: "product owner (not yet assigned)",
}

const clear: typeof Catalog.Encoded["requirements"][number] = {
  id: "REQ-CLEAR",
  revision,
  provenance,
  approval: "proposed",
  text: "The rating feedback is clear to the person.",
  evaluator: "rubric-assessment",
  evaluatorRevision: revision,
  category: "qualitative",
  parameters: [],
  rubric: "clarity",
}

const noAssessments: ReadonlyArray<string> = []

const shop = DeclarationSchema.make({
  id: "shop",
  revision,
  provenance,
  approval,
  imports: [{ alias: "platform", catalog: "effect-domains-platform-obligations", revision }],
  approvals: [],
  actors: [{ id: "person", revision, provenance, approval, binding: "public", description: "An ordinary person." }],
  contexts: [{ id: "ctx", revision, provenance, approval, narrative: "The person has a rating to record.", fixtures: ["fixture"] }],
  needs: [{ id: "need", revision, provenance, approval, text: "Record ratings." }, { id: "orphan-need", revision, provenance, approval, text: "An unmet need." }],
  capabilities: [{ id: "cap", revision, provenance, approval, resource: "ratings", operations: ["ratings.rate"] }, { id: "spare-cap", revision, provenance, approval, resource: "ratings", operations: [] }],
  features: [{ id: "feature", revision, provenance, approval, title: "Ratings", capabilities: ["cap"] }],
  textFixtures: [],
  rubrics: [clarity],
  requirements: [requirement("REQ-CHECK"), preserve, requirement("REQ-UNUSED"), clear],
  stories: [
    { id: "story", revision, provenance, approval, original: "As a person, I want to record a rating.", actor: "person", context: "ctx", need: "need", capabilities: ["cap"], requirements: ["REQ-CHECK", "REQ-PRESERVE"], nonGoals: ["Discoverability"], openDecisions: [] },
    { id: "lonely-story", revision, provenance, approval, original: "As a person, I want something unexercised.", actor: "person", context: "ctx", need: "orphan-need", capabilities: [], requirements: [], nonGoals: [], openDecisions: [] },
  ],
  scenarios: [scenario("first", ["REQ-CLEAR"]), scenario("second", noAssessments), scenario("third", noAssessments), scenario("fourth", noAssessments)],
})

const bound = (reference: string) => BoundRequirement.make({ reference, id: reference, revision, text: `${reference} holds.`, category: "behavior", evaluator: "check", evaluatorRevision: revision })

type RunDeclaration = typeof RetainedRun.Encoded
type ScenarioRun = RunDeclaration["scenarios"][number]
type ResultDeclaration = ScenarioRun["results"][number]
type StatusDeclaration = ResultDeclaration["status"]
type EvidenceFiles = ReadonlyArray<readonly [string, string]>

const result = (scenarioId: string, reference: string, status: StatusDeclaration, requirementRevision: string, basis: string): ResultDeclaration => ({
  requirement: reference,
  requirementRevision,
  scenario: scenarioId,
  scenarioRevision: revision,
  evaluator: "check",
  evaluatorRevision: revision,
  basis,
  status,
})

const asserted = (scenarioId: string, reference: string, status: StatusDeclaration) => result(scenarioId, reference, status, revision, assertion)

const retained = (build: string, startedAt: string, scenarios: ReadonlyArray<ScenarioRun>) => RunSchema.make({
  format: "shop-acceptance@1",
  startedAt,
  finishedAt: startedAt,
  build: { application: "shop", sha256: build, catalogHash },
  catalog: { id: "shop", revision },
  scenarios,
})

const ran = (scenarioId: string, results: ReadonlyArray<ResultDeclaration>): ScenarioRun => ({ scenario: { id: scenarioId, revision }, results })

const firstCheck = asserted("first", "REQ-CHECK", "pass")
const firstPreserve = asserted("first", "REQ-PRESERVE", "blocked")
const thirdCheck = asserted("third", "REQ-CHECK", "fail")
const fourthCheck = asserted("fourth", "REQ-CHECK", "inconclusive")
const fourthPreserve = asserted("fourth", "REQ-PRESERVE", "pass")
const firstRan = ran("first", [firstCheck, firstPreserve])
const thirdRan = ran("third", [thirdCheck])
const fourthRan = ran("fourth", [fourthCheck, fourthPreserve])
const currentRun = retained(currentBuild, "2026-10-10T10:00:00.000Z", [firstRan, thirdRan, fourthRan])
const revisedPreserve = result("second", "REQ-PRESERVE", "pass", "0", assertion)
const revisedRan = ran("second", [revisedPreserve])
const revisedRun = retained(currentBuild, "2026-10-10T11:00:00.000Z", [revisedRan])
const oldFirstCheck = asserted("first", "REQ-CHECK", "fail")
const oldSecondCheck = asserted("second", "REQ-CHECK", "pass")
const oldFirstRan = ran("first", [oldFirstCheck])
const oldSecondRan = ran("second", [oldSecondCheck])
const laterOldRun = retained(oldBuild, "2026-10-10T12:00:00.000Z", [oldFirstRan, oldSecondRan])

// The format-specific sections, a null interruption, and the missing finishedAt prove decoding keeps only the shared fields because formats differ elsewhere.
const legacyRun = `{"format":"shop-acceptance@0","startedAt":"2026-10-09T09:00:00.000Z","verifier":{"cases":3},"build":{"application":"other","sha256":"${oldBuild}","catalogHash":"${catalogHash}","files":[]},"catalog":{"id":"other","revision":"1","actors":[]},"scenarios":[{"scenario":{"id":"x","revision":"1","goal":"g"},"interruption":null,"results":[]}]}`

const directoryOptions = { recursive: true } as const

const placeFile = (root: string) => Effect.fn("QueryTest.placeFile")(function* ([path, content]: readonly [string, string]) {
  const filename = join(root, path)
  const directory = dirname(filename)

  yield* Effect.tryPromise({ try: () => mkdir(directory, directoryOptions), catch: String })
  yield* Effect.tryPromise({ try: () => writeFile(filename, content), catch: String })
})

const encoded = (value: RunDeclaration) => JSON.stringify(value)

const evidenceRoot = Effect.fn("QueryTest.evidenceRoot")(function* (files: EvidenceFiles) {
  const root = yield* scopedTemporaryDirectory("acceptance-query-")

  yield* Effect.forEach(files, placeFile(root))

  return root
})

const standardRuns: EvidenceFiles = [
  ["a-current/run.json", encoded(currentRun)],
  ["b-revised/run.json", encoded(revisedRun)],
  ["c-old/run.json", encoded(laterOldRun)],
  ["d-legacy/run.json", legacyRun],
  ["e-broken/run.json", "{\"format\": 1}"],
  ["e-broken/lineage.json", "not a run"],
]

const passingScenario = (id: string) => {
  const check = asserted(id, "REQ-CHECK", "pass")
  const kept = asserted(id, "REQ-PRESERVE", "pass")

  return ran(id, [check, kept])
}

const passingAll = Array.map(["first", "second", "third", "fourth"], passingScenario)
const passingSubset = Array.map(["first", "second"], passingScenario)
const allPassRun = retained(currentBuild, "2026-10-10T13:00:00.000Z", passingAll)
const subsetRun = retained(currentBuild, "2026-10-10T13:00:00.000Z", passingSubset)
const modelAssessment = result("first", "REQ-CHECK", "pass", revision, "model assessment")
const clearResult: ResultDeclaration = { requirement: "REQ-CLEAR", requirementRevision: revision, scenario: "first", scenarioRevision: revision, evaluator: "rubric-assessment", evaluatorRevision: revision, basis: "model assessment", status: "inconclusive" }
const blockedClear: ResultDeclaration = { requirement: "REQ-CLEAR", requirementRevision: revision, scenario: "first", scenarioRevision: revision, evaluator: "rubric-assessment", evaluatorRevision: revision, basis: "model assessment", status: "blocked" }
const proposedClarity = { id: "clarity", revision, approval: "proposed" as const }
const clearAssessment = { result: clearResult, requirementApproval: "proposed" as const, rubric: proposedClarity, level: "clear" }
const unratedClear = { result: blockedClear, requirementApproval: "proposed" as const, rubric: proposedClarity }
const assessedRan: ScenarioRun = { scenario: { id: "first", revision }, results: [modelAssessment], assessments: [clearAssessment] }
const replayedRan: ScenarioRun = { scenario: { id: "first", revision }, results: [], assessments: [unratedClear] }
const assessedRun = retained(currentBuild, "2026-10-10T13:00:00.000Z", [assessedRan])
const replayedRun = retained(currentBuild, "2026-10-10T14:00:00.000Z", [replayedRan])
const allPassRuns: EvidenceFiles = [["all/run.json", encoded(allPassRun)]]
const subsetRuns: EvidenceFiles = [["subset/run.json", encoded(subsetRun)]]
const assessedRuns: EvidenceFiles = [["assessed/run.json", encoded(assessedRun)], ["replayed/run.json", encoded(replayedRun)]]
const unknownBasis = result("first", "REQ-CHECK", "pass", revision, "operator opinion")
const unknownBasisRan = ran("first", [unknownBasis])
const unknownBasisRun = retained(currentBuild, "2026-10-10T13:00:00.000Z", [unknownBasisRan])
const unknownBasisRuns: EvidenceFiles = [["unknown-basis/run.json", encoded(unknownBasisRun)]]

const unfinishedRun = RunSchema.make({
  format: "shop-acceptance@1",
  startedAt: "2026-10-10T14:00:00.000Z",
  build: { application: "shop", sha256: currentBuild, catalogHash },
  catalog: { id: "shop", revision },
  scenarios: passingAll,
})

const unfinishedRuns: EvidenceFiles = [["unfinished/run.json", encoded(unfinishedRun)]]
const currentShort = Text.slice(0, 12)(currentBuild)
const oldShort = Text.slice(0, 12)(oldBuild)

const productWith = Effect.fn("QueryTest.product")(function* (files: EvidenceFiles) {
  const root = yield* evidenceRoot(files)
  const scan = yield* readEvidence(root)
  const catalog = yield* Schema.decodeUnknownEffect(Catalog)(shop)
  const platform = yield* Schema.decodeUnknownEffect(Catalog)(platformObligations)
  const imports = [ImportedCatalog.make({ alias: "platform", catalog: platform })]
  const current = CurrentBuild.make({ sha256: currentBuild, catalogHash })
  const owned = Array.filter(scan.runs, isShopRun)

  return Product.make({
    application: "shop",
    title: "Shop",
    catalog,
    requirements: [bound("REQ-CHECK"), bound("REQ-PRESERVE")],
    imports,
    operations: ["ratings.rate", "ratings.list"],
    fields: nativeFieldsOf(TestApplication),
    evaluators: { check: revision },
    current,
    runs: owned,
    unreadable: scan.unreadable,
  })
})

const isShopRun = (entry: Product["runs"][number]) => Text.startsWith("shop-acceptance@1")(entry.run.format)

const stateOf = (scope: ScopeEvidence) => `${scope.scope.scenario}/${scope.scope.requirement}=${scope.state}`

const readEvidenceTest = Effect.gen(function* () {
  const root = yield* evidenceRoot(standardRuns)
  const scan = yield* readEvidence(root)
  const paths = Array.map(scan.runs, Struct.get("path"))
  const unreadable = Array.map(scan.unreadable, Struct.get("path"))
  const legacy = yield* pipe(scan.runs, Array.findFirst(isLegacy), Effect.fromOption)
  const legacyScenario = yield* pipe(legacy.run.scenarios, Array.head, Effect.fromOption)
  const unfinished = Option.isNone(legacy.run.finishedAt)
  const uninterrupted = Option.isNone(legacyScenario.interruption)

  expect(paths).toEqual(["a-current", "b-revised", "c-old", "d-legacy"])
  expect(unreadable).toEqual(["e-broken"])
  expect(unfinished).toBe(true)
  expect(uninterrupted).toBe(true)
})

const isLegacy = (entry: Product["runs"][number]) => Text.startsWith("d-")(entry.path)

const qaTest = Effect.gen(function* () {
  const product = yield* productWith(standardRuns)
  const view = qaView(product)
  const needing = Array.map(view.needingRun, Struct.get("scenario"))
  const failing = Array.map(view.failing, Struct.get("scenario"))
  const scopes = Array.flatMap(view.needingRun, Struct.get("scopes"))
  const states = pipe(scopes, Array.map(stateOf), Array.dedupe)
  const reasons = Array.flatMap(view.needingRun, Struct.get("reasons"))
  const second = yield* pipe(view.needingRun, Array.findFirst(isSecond), Effect.fromOption)

  expect(needing).toEqual(["first@1", "second@1", "third@1", "fourth@1"])
  expect(failing).toEqual(["third@1"])
  expect(view.passing).toBe(0)
  expect(states).toEqual(["first/REQ-CHECK=pass", "first/REQ-PRESERVE=blocked", "second/REQ-CHECK=stale", "second/REQ-PRESERVE=stale", "third/REQ-CHECK=fail", "third/REQ-PRESERVE=missing", "fourth/REQ-CHECK=inconclusive", "fourth/REQ-PRESERVE=pass"])
  expect(second.reasons).toEqual([`stale: build ${oldShort} is not the current build ${currentShort} (newest c-old) [REQ-CHECK]`, "stale: requirement revision 0 is not the current 1 (newest b-revised) [REQ-PRESERVE]"])
  expect(reasons).toContain("missing: no retained result [REQ-PRESERVE]")
  expect(view.summary).toContain("not completion and not validated user benefit")
  expect(view.unreadable).toHaveLength(1)
})

const isSecond = (entry: QaScenario) => Text.startsWith("second")(entry.scenario)

const entryFor = (product: Product, reference: string) => {
  const wanted = Option.some(reference)
  const view = requirementView(wanted)(product)

  return pipe(view.entries, Array.head, Effect.fromOption)
}

const conformanceTest = Effect.gen(function* () {
  const complete = yield* productWith(allPassRuns)
  const subset = yield* productWith(subsetRuns)
  const assessed = yield* productWith(assessedRuns)
  const unknownAssessed = yield* productWith(unknownBasisRuns)
  const unfinished = yield* productWith(unfinishedRuns)
  const completeEntry = yield* entryFor(complete, "REQ-CHECK")
  const subsetEntry = yield* entryFor(subset, "REQ-CHECK")
  const assessedEntry = yield* entryFor(assessed, "REQ-CHECK")
  const unknownEntry = yield* entryFor(unknownAssessed, "REQ-CHECK")
  const unfinishedEntry = yield* entryFor(unfinished, "REQ-CHECK")
  const unfinishedScope = yield* pipe(unfinishedEntry.scopes, Array.head, Effect.fromOption)
  const unfinishedLatest = yield* Effect.fromOption(unfinishedScope.latest)
  const unused = yield* entryFor(subset, "REQ-UNUSED")
  const shared = yield* entryFor(subset, "PLATFORM-PRESERVE")
  const clearEntry = yield* entryFor(assessed, "REQ-CLEAR")
  const unassessedClear = yield* entryFor(subset, "REQ-CLEAR")
  const builds = Array.map(subsetEntry.builds, Struct.get("statuses"))
  const qa = qaView(assessed)

  expect(completeEntry.conformance.state).toBe("exercised-scope-passes")
  expect(completeEntry.conformance.summary).toContain("covers only the declared scenarios and inputs")
  expect(completeEntry.benefit).toBe(notAssessed)
  expect(completeEntry.implementation.state).toBe("bound")
  expect(subsetEntry.conformance.state).toBe("partial")
  expect(subsetEntry.conformance.passing).toBe(2)
  expect(subsetEntry.conformance.summary).toBe("2 of 4 exercised scope(s) pass on the current build (2 pass, 2 missing); a passing subset is not completion")
  expect(subsetEntry.stories).toEqual(["story@1"])
  expect(builds).toEqual([["first=pass", "second=pass"]])
  expect(assessedEntry.benefit).toBe(notAssessed)
  expect(clearEntry.benefit).toBe("model assessment (proposed rubric; not approved): inconclusive (rated \"clear\") (first, assessed) [unresolved assessment]")
  expect(clearEntry.conformance.state).toBe("untested")
  expect(clearEntry.conformance.summary).toContain("not an executable obligation")
  expect(clearEntry.implementation.state).toBe("assessment")
  expect(clearEntry.scopes).toEqual([])
  expect(unassessedClear.benefit).toBe(notAssessed)
  expect(qa.assessments).toEqual(["first@1 assesses REQ-CLEAR: model assessment (proposed rubric; not approved): inconclusive (rated \"clear\") (first, assessed) [unresolved assessment]"])
  expect(qa.passing).toBe(0)
  expect(unknownEntry.benefit).toBe(notAssessed)
  expect(unfinishedEntry.conformance.state).toBe("untested")
  expect(unfinishedScope.state).toBe("stale")
  expect(unfinishedLatest.staleness).toEqual(["the run never finished, so its results are not current evidence"])
  expect(unused.implementation.state).toBe("no-scenario")
  expect(unused.conformance.state).toBe("untested")
  expect(shared.reference).toBe("platform:PLATFORM-PRESERVE")
  expect(shared.implementation.state).toBe("no-evaluator")
  expect(shared.refinedBy).toEqual(["REQ-PRESERVE"])
  expect(shared.conformance.state).toBe("untested")
})

const implementationTest = Effect.gen(function* () {
  const product = yield* productWith(subsetRuns)
  const wanted = Option.some("ratings.rate")
  const everything = Option.none<string>()
  const rated = implementationView(wanted)(product)
  const all = implementationView(everything)(product)
  const entry = yield* pipe(rated.operations, Array.head, Effect.fromOption)
  const first = yield* pipe(entry.scenarios, Array.head, Effect.fromOption)
  const input = yield* pipe(first.inputs, Array.head, Effect.fromOption)
  const operations = Array.map(all.operations, Struct.get("operation"))
  const listing = yield* pipe(all.operations, Array.findLast(isListing), Effect.fromOption)

  expect(entry.native).toBe(true)
  expect(entry.capabilities).toEqual(["cap@1"])
  expect(entry.features).toEqual(["feature@1"])
  expect(entry.stories).toEqual(["story@1"])
  expect(entry.requirements).toEqual(["REQ-CHECK@1 via check@1: REQ-CHECK holds.", "REQ-PRESERVE@1 via check@1: REQ-PRESERVE holds."])
  expect(input.fields).toEqual(["rating ← native sample"])
  expect(input.outcome).toBe("accepted")
  expect(operations).toEqual(["ratings.rate", "ratings.list"])
  expect(listing.capabilities).toEqual([])
})

const isListing = (entry: OperationEntry) => Text.endsWith(".list")(entry.operation)

const gapTest = Effect.gen(function* () {
  const product = yield* productWith(subsetRuns)
  const view = gapView(product)

  expect(view.capabilitiesWithoutNeed).toEqual(["spare-cap@1"])
  expect(view.needsWithoutCapabilities).toEqual(["orphan-need@1"])
  expect(view.requirementsWithoutScenarios).toEqual(["REQ-UNUSED@1"])
  expect(view.storiesWithoutScenarios).toEqual(["lonely-story@1"])
  expect(view.operationsWithoutCapability).toEqual(["ratings.list"])
  expect(view.refinements).toEqual(["REQ-PRESERVE@1 refines platform:PLATFORM-PRESERVE (scope=the other records)"])
  expect(view.unrefinedShared).toEqual([])
})

type Partition = ReturnType<typeof gapView>["partitions"][number]

const coveringOperation = (operation: string) => (partition: Partition) => Text.startsWith(operation)(partition.operation)
const isRate = coveringOperation("ratings.rate")
const isTag = coveringOperation("tickets.prioritize")
const isList = coveringOperation("ratings.list")

class PriorityUnavailable extends Schema.TaggedError<PriorityUnavailable>()("PriorityUnavailable", {}) {}

const PrioritizePayloadSchema = Schema.Struct({ priority: Schema.Literals(["low", "normal", "urgent"]) })

interface PrioritizePayload extends Schema.Schema.Type<typeof PrioritizePayloadSchema> {}

const prioritize = Command.family("tickets.", PriorityUnavailable).define({ name: "prioritize", payload: PrioritizePayloadSchema, success: Schema.String })

const prioritizeHandler = Command.implement(prioritize, Effect.fn("QueryTest.prioritize")(function* (payload: PrioritizePayload) {
  return yield* Effect.succeed(payload.priority)
}))

const TicketCommands = Command.bundle(prioritizeHandler)
const ticketPart = Part.command(TicketCommands)
const ticketDefinition = Application.define({ name: "query-ticket-test", parts: [ticketPart] })
const compiledTickets = Application.compile(ticketDefinition)

// The ticket application compiles synchronously because it is a pure definition without services.
const TicketApplication = Effect.runSync(compiledTickets)

type InputDeclaration = ScenarioDeclaration["inputs"][number]

const priorityInput = (priority: string): InputDeclaration => ({ id: priority, operation: "tickets.prioritize", description: `Prioritize ${priority}`, fields: { priority: { source: "literal", value: priority } }, validity: "native-valid", outcome: { kind: "accepted" } })
const lowInput = priorityInput("low")
const urgentInput = priorityInput("urgent")
const minimumInput: InputDeclaration = { id: "minimum", operation: "ratings.rate", description: "The lowest rating", fields: { rating: { source: "native", strategy: "minimum" } }, validity: "native-valid", outcome: { kind: "accepted" } }
const taggingScenario: ScenarioDeclaration = { ...scenario("tagging", noAssessments), operations: ["tickets.prioritize", "ratings.rate"], inputs: [lowInput, urgentInput, minimumInput], required: ["low", "urgent", "minimum"] }
const tagged = DeclarationSchema.make({ ...shop, scenarios: [...shop.scenarios, taggingScenario] })
const ratingFields = nativeFieldsOf(TestApplication)
const ticketFields = nativeFieldsOf(TicketApplication)

const partitionTest = Effect.gen(function* () {
  const product = yield* productWith(subsetRuns)
  const catalog = yield* Schema.decodeUnknownEffect(Catalog)(tagged)
  const fields = [...ratingFields, ...ticketFields]

  const extended = Product.make({
    application: product.application,
    title: product.title,
    catalog,
    requirements: product.requirements,
    imports: product.imports,
    operations: ["ratings.rate", "ratings.list", "tickets.prioritize"],
    fields,
    evaluators: product.evaluators,
    current: product.current,
    runs: product.runs,
    unreadable: product.unreadable,
  })

  const view = gapView(extended)
  const rate = yield* pipe(view.partitions, Array.findFirst(isRate), Effect.fromOption)
  const tags = yield* pipe(view.partitions, Array.findFirst(isTag), Effect.fromOption)
  const listing = yield* pipe(view.partitions, Array.findFirst(isList), Effect.fromOption)

  expect(view.partitionScope).toBe("declared-vocabulary coverage; not exhaustiveness")
  expect(rate.inputCases).toBe(5)
  expect(rate.overlaps).toEqual(["first/sample, second/sample, third/sample, fourth/sample declare identical sources (rating ← native sample)"])
  expect(rate.unexercisedMembers).toEqual([])

  expect(rate.boundaries).toEqual([
    "rating (applicable minimum, maximum, below, above, fractional): exercised native sample, minimum; boundary strategies never exercised: maximum, below, above, fractional",
    "score (applicable minimum, maximum, below, above, fractional): exercised native none; boundary strategies never exercised: minimum, maximum, below, above, fractional",
  ])

  expect(tags.inputCases).toBe(2)
  expect(tags.overlaps).toEqual([])
  expect(tags.unexercisedMembers).toEqual(["priority: \"normal\" never exercised (exercised: \"low\", \"urgent\")"])
  expect(tags.boundaries).toEqual([])
  expect(listing.inputCases).toBe(0)
})

const impactTest = Effect.gen(function* () {
  const product = yield* productWith(standardRuns)
  const shared = impactView("platform:PLATFORM-PRESERVE")(product)
  const evaluator = impactView("check")(product)
  const operation = impactView("ratings.rate")(product)
  const unknown = impactView("nothing-recorded")(product)
  const actor = impactView("person")(product)
  const importedCatalog = impactView("effect-domains-platform-obligations")(product)

  expect(shared.matches).toEqual(["shared requirement platform:PLATFORM-PRESERVE (effect-domains-platform-obligations@1)"])
  expect(shared.declarations).toEqual(["requirement REQ-PRESERVE@1", "story story@1"])
  expect(shared.scenarios).toEqual(["first", "second", "third", "fourth"])
  expect(shared.runs).toEqual([`a-current (current build ${currentShort}, 2026-10-10T10:00:00.000Z): first, third, fourth`, `b-revised (current build ${currentShort}, 2026-10-10T11:00:00.000Z): second`, `c-old (build ${oldShort}, 2026-10-10T12:00:00.000Z): first, second`])
  expect(shared.caveat).toBe(impactCaveat)
  expect(evaluator.declarations).toEqual(["requirement REQ-CHECK@1", "requirement REQ-PRESERVE@1", "requirement REQ-UNUSED@1", "story story@1"])
  expect(operation.matches).toEqual(["native operation ratings.rate"])
  expect(operation.declarations).toEqual(["capability cap@1", "story story@1", "input first/sample", "input second/sample", "input third/sample", "input fourth/sample"])
  expect(actor.scenarios).toEqual(["first", "second", "third", "fourth"])
  expect(importedCatalog.matches).toEqual(["imported catalog platform (effect-domains-platform-obligations@1)"])
  expect(importedCatalog.declarations).toEqual(["requirement REQ-PRESERVE@1", "story story@1"])
  expect(importedCatalog.scenarios).toEqual(["first", "second", "third", "fourth"])
  expect(unknown.matches).toEqual([])
  expect(unknown.scenarios).toEqual([])
  expect(unknown.caveat).toBe(impactCaveat)
})

const documentationTest = Effect.gen(function* () {
  const product = yield* productWith(subsetRuns)
  const view = documentationView(product)
  const journey = yield* pipe(view.journeys, Array.head, Effect.fromOption)
  const story = yield* pipe(journey.stories, Array.head, Effect.fromOption)

  expect(journey.actor).toBe("person@1")
  expect(story.context).toBe("ctx: The person has a rating to record.")
  expect(story.need).toBe("need: Record ratings.")
  expect(story.capabilities).toEqual(["cap@1 in feature \"Ratings\": ratings via ratings.rate"])
  expect(story.requirements).toEqual(["REQ-CHECK@1: REQ-CHECK holds. [conformance: partial; user benefit: not assessed]", "REQ-PRESERVE@1: Other records stay unchanged. [conformance: partial; user benefit: not assessed]"])
  expect(story.scenarios).toEqual(["first@1: Reach the first outcome. [2 pass]", "second@1: Reach the second outcome. [2 pass]", "third@1: Reach the third outcome. [2 missing]", "fourth@1: Reach the fourth outcome. [2 missing]"])
})

it.effect("retained runs decode by their shared fields and undecodable runs are reported", Function.constant(readEvidenceTest))
it.effect("QA lists missing, stale-build, stale-revision, blocked, and inconclusive scopes and failures separately", Function.constant(qaTest))
it.effect("a passing subset is partial, never completion, and user benefit stays not assessed without a model or qualitative assessment", Function.constant(conformanceTest))
it.effect("the implementation view binds an operation to capabilities, requirements, scenarios, and inputs", Function.constant(implementationTest))
it.effect("gaps expose unlinked declarations and shared-obligation refinements", Function.constant(gapTest))
it.effect("change impact lists recorded dependents and runs as candidates with the unrecorded-effects caveat", Function.constant(impactTest))
it.effect("documentation journeys carry conformance state and never infer user benefit", Function.constant(documentationTest))
it.effect("partition coverage reports identical sources, unexercised enum members, and unexercised boundary strategies as declared-vocabulary coverage", Function.constant(partitionTest))
