import { expect, it } from "@effect/vitest"
import { Array, Effect, Equal, Function, Option, Schema, String as Text, Struct, flow, pipe } from "effect"
import { Application, Part } from "effect-domains/application"
import { Command } from "effect-domains/command"
import { CatalogBindings, validateCatalog } from "./catalog.ts"
import { Catalog } from "./model.ts"
import { platformObligations } from "./obligations.ts"
import { TestApplication } from "./test-application.ts"

const DeclarationSchema = Schema.toEncoded(Catalog)
const revision = "1"
const provenance = "catalog test"
const approval = "approved"
const platform = { alias: "platform", catalog: "effect-domains-platform-obligations", revision }

const sharedCatalog = (id: string, imports: typeof Catalog.Encoded["imports"]) => DeclarationSchema.make({
  id,
  revision,
  provenance,
  approval,
  imports,
  approvals: [{ id: `${id}-approval`, by: "reviewer", on: "2026-10-10", basis: "test fixture", approves: [`${id}@1`, "SHARED-CHECK@1"] }],
  actors: [],
  contexts: [],
  needs: [],
  capabilities: [],
  features: [],
  textFixtures: [],
  rubrics: [],
  requirements: [{ id: "SHARED-CHECK", revision, provenance, approval, text: "A shared evaluated obligation.", evaluator: "check", evaluatorRevision: revision, category: "behavior", parameters: [] }],
  stories: [],
  scenarios: [],
})

const sharedA = sharedCatalog("shared-a", [])
const sharedB = sharedCatalog("shared-b", [])
const cycleA = sharedCatalog("cycle-a", [{ alias: "next", catalog: "cycle-b", revision }])
const cycleB = sharedCatalog("cycle-b", [{ alias: "next", catalog: "cycle-a", revision }])
const unapprovedShared = DeclarationSchema.make({ ...sharedCatalog("unapproved-shared", []), approval: "proposed" })

const bindings = CatalogBindings.make({
  evaluators: { check: revision },
  fixtures: ["fixture-a", "fixture-b"],
  actors: ["public"],
  facts: [],
  probes: [],
  catalogs: [platformObligations, sharedA, sharedB, cycleA, cycleB, unapprovedShared],
})

type RequirementDeclaration = typeof Catalog.Encoded["requirements"][number]
type StoryDeclaration = typeof Catalog.Encoded["stories"][number]

const checkRequirement: RequirementDeclaration = { id: "REQ-CHECK", revision, provenance, approval, text: "The exercised obligation holds.", evaluator: "check", evaluatorRevision: revision, category: "behavior", parameters: [] }

const preserveRequirement: RequirementDeclaration = {
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

const story: StoryDeclaration = { id: "story", revision, provenance, approval, original: "As a person, I want a checked outcome.", actor: "person", context: "ctx", need: "need", capabilities: [], requirements: ["REQ-CHECK", "REQ-PRESERVE"], nonGoals: [], openDecisions: [] }
const scenario: typeof Catalog.Encoded["scenarios"][number] = { id: "scenario", revision, provenance, approval, story: "story", actor: "person", fixture: "fixture-a", goal: "Reach the checked outcome.", operations: [], inputs: [], required: [], observations: [], probes: [], requirements: ["REQ-CHECK", "REQ-PRESERVE"], assessments: [], reload: false }
const currentApprovals = ["tiny@1", "person@1", "ctx@1", "need@1", "REQ-CHECK@1", "REQ-PRESERVE@1", "story@1", "scenario@1"]
const approvalRecord = { id: "tiny-approval", by: "reviewer", on: "2026-10-10", basis: "test fixture", approves: currentApprovals }

const tiny = DeclarationSchema.make({
  id: "tiny",
  revision,
  provenance,
  approval,
  imports: [platform],
  approvals: [approvalRecord],
  actors: [{ id: "person", revision, provenance, approval, binding: "public", description: "An ordinary person." }],
  contexts: [{ id: "ctx", revision, provenance, approval, narrative: "The person has something to check.", fixtures: ["fixture-a"] }],
  needs: [{ id: "need", revision, provenance, approval, text: "Know that the outcome holds." }],
  capabilities: [],
  features: [],
  textFixtures: [],
  rubrics: [],
  requirements: [checkRequirement, preserveRequirement],
  stories: [story],
  scenarios: [scenario],
})

const capability: typeof Catalog.Encoded["capabilities"][number] = { id: "cap", revision, provenance, approval, resource: "ratings", operations: ["ratings.rate"] }
const containsFragment = ([message, fragment]: readonly [string, string]) => Text.includes(fragment)(message)

const fragmentsFound = (messages: ReadonlyArray<string>, fragments: ReadonlyArray<string>) => {
  const pairs = Array.zip(messages, fragments)
  const found = Array.map(pairs, containsFragment)
  const expectedCount = Array.length(fragments)
  const observedCount = Array.length(messages)
  const sameLength = Equal.equals(expectedCount, observedCount)

  return sameLength && Array.every(found, Boolean)
}

const rejection = Effect.fn("CatalogTest.rejection")(function* (declaration: typeof Catalog.Encoded) {
  const failure = yield* pipe(validateCatalog(declaration, bindings, TestApplication), Effect.flip)

  expect(failure.boundary).toBe("catalog")

  return failure.message
})

const validCatalogTest = Effect.gen(function* () {
  const validated = yield* validateCatalog(tiny, bindings, TestApplication)
  const references = Array.map(validated.requirements, Struct.get("reference"))
  const evaluators = Array.map(validated.requirements, Struct.get("evaluator"))
  const sharedReferences = ["REQ-CHECK", "shared:SHARED-CHECK"]
  const sharedImports = [platform, { alias: "shared", catalog: "shared-a", revision }]
  const sharedDeclaration = DeclarationSchema.make({ ...tiny, imports: sharedImports, stories: [{ ...story, requirements: sharedReferences }], scenarios: [{ ...scenario, requirements: sharedReferences }] })
  const qualified = yield* validateCatalog(sharedDeclaration, bindings, TestApplication)
  const qualifiedReferences = Array.map(qualified.requirements, Struct.get("reference"))
  const qualifiedIds = Array.map(qualified.requirements, Struct.get("id"))

  expect(references).toEqual(["REQ-CHECK", "REQ-PRESERVE"])
  expect(evaluators).toEqual(["check", "check"])
  expect(qualifiedReferences).toEqual(sharedReferences)
  expect(qualifiedIds).toEqual(["REQ-CHECK", "SHARED-CHECK"])
})

const platformCatalogTest = Effect.gen(function* () {
  const validated = yield* validateCatalog(platformObligations, bindings, TestApplication)
  const preserve = yield* pipe(validated.catalog.requirements, Array.head, Effect.fromOption)
  const parameters = Array.map(preserve.parameters, Struct.get("name"))
  const unevaluated = Option.isNone(preserve.evaluator)

  expect(validated.catalog.id).toBe("effect-domains-platform-obligations")
  expect(validated.catalog.revision).toBe("1")
  expect(validated.requirements).toEqual([])
  expect(preserve.id).toBe("PLATFORM-PRESERVE")
  expect(unevaluated).toBe(true)
  expect(parameters).toEqual(["scope"])
})

const importing = (alias: string, catalog: string) => DeclarationSchema.make({ ...tiny, imports: [platform, { alias, catalog, revision }] })
const approving = (approves: ReadonlyArray<string>) => DeclarationSchema.make({ ...tiny, approvals: [{ ...approvalRecord, approves }] })
const referencing = (requirements: ReadonlyArray<string>) => DeclarationSchema.make({ ...tiny, stories: [{ ...story, requirements }], scenarios: [{ ...scenario, requirements }] })

const importRejectionTest = Effect.gen(function* () {
  const missing = DeclarationSchema.make({ ...tiny, imports: [platform, { alias: "absent", catalog: "no-such-catalog", revision }] })
  const obsolete = DeclarationSchema.make({ ...tiny, imports: [{ ...platform, revision: "0" }] })
  const ambiguous = DeclarationSchema.make({ ...tiny, imports: [platform, { alias: "a", catalog: "shared-a", revision }, { alias: "b", catalog: "shared-b", revision }], stories: [{ ...story, requirements: ["REQ-CHECK", "REQ-PRESERVE", "SHARED-CHECK"] }] })
  const unknown = referencing(["REQ-CHECK", "nowhere:REQ-CHECK"])
  const absentTarget = referencing(["REQ-CHECK", "platform:NOT-THERE"])
  const duplicateAlias = DeclarationSchema.make({ ...tiny, imports: [platform, platform] })
  const cyclic = importing("loop", "cycle-a")
  const selfImport = importing("self", "tiny")
  const unapproved = importing("proposed", "unapproved-shared")
  const messages = yield* Effect.forEach([missing, obsolete, ambiguous, unknown, absentTarget, duplicateAlias, cyclic, selfImport, unapproved], rejection)

  const fragments = [
    "Missing import absent (no-such-catalog@1): no available catalog no-such-catalog",
    "Obsolete import platform (effect-domains-platform-obligations@0): available revision(s) 1; review the changed obligations and update the import revision",
    "Ambiguous requirement reference SHARED-CHECK: declared by imports a, b; qualify as alias:SHARED-CHECK",
    "Unknown import alias nowhere in nowhere:REQ-CHECK",
    "Missing requirement NOT-THERE in imported catalog effect-domains-platform-obligations@1 (platform)",
    "Duplicate import alias: platform",
    "Import cycle tiny -> cycle-a -> cycle-b -> cycle-a",
    "Import cycle tiny -> tiny",
    "Imported catalog proposed (unapproved-shared@1): Declaration unapproved-shared@1 is proposed, not an approved obligation",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(found).toBe(true)
})

const refinementRejectionTest = Effect.gen(function* () {
  const missingParameter = DeclarationSchema.make({ ...tiny, requirements: [checkRequirement, { ...preserveRequirement, refines: { requirement: "platform:PLATFORM-PRESERVE", arguments: {} } }] })
  const extraParameter = DeclarationSchema.make({ ...tiny, requirements: [checkRequirement, { ...preserveRequirement, refines: { requirement: "platform:PLATFORM-PRESERVE", arguments: { scope: "the other records", depth: "all" } } }] })
  const parameterless = DeclarationSchema.make({ ...tiny, requirements: [checkRequirement, { ...preserveRequirement, refines: { requirement: "REQ-CHECK", arguments: { scope: "the other records" } } }] })
  const unresolved = DeclarationSchema.make({ ...tiny, requirements: [checkRequirement, { ...preserveRequirement, refines: { requirement: "platform:UNKNOWN", arguments: { scope: "the other records" } } }] })
  const cyclic = DeclarationSchema.make({ ...tiny, requirements: [{ ...checkRequirement, refines: { requirement: "REQ-PRESERVE", arguments: {} } }, { ...preserveRequirement, refines: { requirement: "REQ-CHECK", arguments: {} } }] })
  const messages = yield* Effect.forEach([missingParameter, extraParameter, parameterless, unresolved, cyclic], rejection)

  const fragments = [
    "Requirement REQ-PRESERVE refinement of platform:PLATFORM-PRESERVE does not bind parameter(s) scope",
    "Requirement REQ-PRESERVE refinement of platform:PLATFORM-PRESERVE binds unknown parameter(s) depth; PLATFORM-PRESERVE declares scope",
    "binds unknown parameter(s) scope; REQ-CHECK declares no parameters",
    "Requirement REQ-PRESERVE refines an unresolved requirement: Missing requirement UNKNOWN in imported catalog",
    "Requirement REQ-CHECK is part of a refinement cycle",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(found).toBe(true)
})

const approvalRejectionTest = Effect.gen(function* () {
  const withoutCheck = Array.remove(currentApprovals, 4)
  const withGhost = Array.append(currentApprovals, "GHOST@1")
  const withMalformed = Array.append(currentApprovals, "REQ-CHECK")
  const authored = DeclarationSchema.make({ ...tiny, requirements: [{ ...checkRequirement, approval: "authored" }, preserveRequirement] })
  const proposed = DeclarationSchema.make({ ...tiny, requirements: [checkRequirement, { ...preserveRequirement, approval: "proposed" }] })
  const unrecorded = approving(withoutCheck)
  const obsolete = DeclarationSchema.make({ ...tiny, requirements: [{ ...checkRequirement, revision: "2" }, preserveRequirement] })
  const ghost = approving(withGhost)
  const malformed = approving(withMalformed)
  const messages = yield* Effect.forEach([authored, proposed, unrecorded, obsolete, ghost, malformed], rejection)

  const fragments = [
    "Declaration REQ-CHECK@1 is authored, not an approved obligation",
    "Story story references REQ-PRESERVE@1, which is proposed; only approved requirements are obligations",
    "Declaration REQ-CHECK@1 is marked approved but no approval record approves REQ-CHECK@1",
    "Declaration REQ-CHECK@2 has only an obsolete approval (REQ-CHECK@1); record an approval of REQ-CHECK@2 before executing it",
    "Approval tiny-approval approves unknown declaration GHOST@1",
    "Approval tiny-approval entry REQ-CHECK is malformed; use id@revision",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(found).toBe(true)
})

const productRejectionTest = Effect.gen(function* () {
  const unboundCheck = Struct.omit(checkRequirement, ["evaluator", "evaluatorRevision"])
  const halfBoundCheck = Struct.omit(checkRequirement, ["evaluatorRevision"])
  const unknownFeature = DeclarationSchema.make({ ...tiny, capabilities: [capability], features: [{ id: "feature", revision, provenance, approval, title: "Feature", capabilities: ["cap", "ghost"] }] })
  const sharedFeatures = DeclarationSchema.make({ ...tiny, capabilities: [capability], features: [{ id: "one", revision, provenance, approval, title: "One", capabilities: ["cap"] }, { id: "two", revision, provenance, approval, title: "Two", capabilities: ["cap"] }] })
  const outsideContext = DeclarationSchema.make({ ...tiny, scenarios: [{ ...scenario, fixture: "fixture-b" }] })
  const missingContext = DeclarationSchema.make({ ...tiny, stories: [{ ...story, context: "missing-context" }] })
  const unevaluated = DeclarationSchema.make({ ...tiny, requirements: [unboundCheck, preserveRequirement] })
  const unpaired = DeclarationSchema.make({ ...tiny, requirements: [halfBoundCheck, preserveRequirement] })
  const messages = yield* Effect.forEach([unknownFeature, sharedFeatures, outsideContext, missingContext, unevaluated, unpaired], rejection)

  const fragments = [
    "Feature feature names unknown capability ghost",
    "Capability cap belongs to more than one feature (one, two)",
    "Scenario scenario fixture fixture-b is not a precondition of context ctx",
    "Missing context missing-context in story story",
    "Requirement REQ-CHECK is referenced by scenario scenario but declares no evaluator binding",
    "Requirement REQ-CHECK must declare evaluator and evaluatorRevision together",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(found).toBe(true)
})

const clarity: typeof Catalog.Encoded["rubrics"][number] = {
  id: "clarity",
  revision,
  provenance,
  approval: "proposed",
  criteria: ["Says what happened"],
  scale: [{ level: "unclear", meaning: "The person cannot tell what happened." }, { level: "clear", meaning: "The person can tell what happened." }],
  threshold: "clear",
  reviewer: "product owner (not yet assigned)",
}

const clearRequirement: RequirementDeclaration = { id: "REQ-CLEAR", revision, provenance, approval: "proposed", text: "The feedback is clear.", evaluator: "rubric-assessment", evaluatorRevision: revision, category: "qualitative", parameters: [], rubric: "clarity" }

type InputDeclaration = typeof Catalog.Encoded["scenarios"][number]["inputs"][number]

const contended: InputDeclaration["outcome"] = { kind: "contended", failures: ["RatingUnavailable"] }
const literal = (value: unknown): InputDeclaration["fields"][string] => ({ source: "literal", value })
const rateFields = { rating: literal(3), score: literal(3), note: literal("A competing note") }
const raceInput = (id: string): InputDeclaration => ({ id, operation: "ratings.rate", description: "Rate the shared subject", fields: rateFields, validity: "native-valid", outcome: contended })
const lanes = [{ id: "first", goal: "Submit the first rating.", inputs: ["race-a"] }, { id: "second", goal: "Submit the second rating.", inputs: ["race-b"] }]
const raceScenario = { ...scenario, operations: ["ratings.rate"], inputs: [raceInput("race-a"), raceInput("race-b")], required: ["race-a", "race-b"], concurrency: { barrier: "submit" as const, lanes } }
const assessedScenario = { ...scenario, assessments: ["REQ-CLEAR"] }
const qualitativeRequirements = [checkRequirement, preserveRequirement, clearRequirement]

const withScenario = (declared: typeof Catalog.Encoded["scenarios"][number], rubrics: typeof Catalog.Encoded["rubrics"], requirements: ReadonlyArray<RequirementDeclaration>) => DeclarationSchema.make({
  ...tiny,
  rubrics,
  requirements,
  scenarios: [declared],
})

const assessmentCatalogTest = Effect.gen(function* () {
  const declared = withScenario(assessedScenario, [clarity], qualitativeRequirements)
  const assessed = yield* validateCatalog(declared, bindings, TestApplication)
  const assessedReferences = Array.map(assessed.assessments, Struct.get("reference"))
  const rubrics = Array.map(assessed.assessments, flow(Struct.get("rubric"), Struct.get("approval")))
  const obligations = Array.map(assessed.requirements, Struct.get("reference"))

  expect(assessedReferences).toEqual(["REQ-CLEAR"])
  expect(rubrics).toEqual(["proposed"])
  expect(obligations).toEqual(["REQ-CHECK", "REQ-PRESERVE"])
})

const assessmentRejectionTest = Effect.gen(function* () {
  const asObligation = withScenario({ ...scenario, requirements: ["REQ-CHECK", "REQ-PRESERVE", "REQ-CLEAR"] }, [clarity], qualitativeRequirements)
  const executableAssessed = withScenario({ ...scenario, assessments: ["REQ-CHECK"] }, [clarity], qualitativeRequirements)
  const offScale = withScenario(assessedScenario, [{ ...clarity, threshold: "excellent" }], qualitativeRequirements)
  const unrated = Struct.omit(clearRequirement, ["rubric"])
  const rubricless = withScenario(assessedScenario, [clarity], [checkRequirement, preserveRequirement, unrated])
  const loneInput = raceInput("race-a")
  const soleLane = withScenario({ ...raceScenario, inputs: [loneInput], required: ["race-a"], concurrency: { barrier: "submit", lanes: [{ id: "first", goal: "Submit.", inputs: ["race-a"] }] } }, [], [checkRequirement, preserveRequirement])
  const sequential = Struct.omit(raceScenario, ["concurrency"])
  const unraced = withScenario(sequential, [], [checkRequirement, preserveRequirement])
  const watched = withScenario({ ...raceScenario, watch: { input: "ghost", probe: "status", subject: "tenant", field: "_tag", terminal: ["Done"], intervalMillis: 100, deadlineSeconds: 5, confirmations: 1 } }, [], [checkRequirement, preserveRequirement])
  const messages = yield* Effect.forEach([asObligation, executableAssessed, offScale, rubricless, soleLane, unraced, watched], rejection)

  const fragments = [
    "Scenario scenario references REQ-CLEAR@1, which is proposed; only approved requirements are obligations",
    "Scenario scenario assesses REQ-CHECK, which is not a qualitative requirement",
    "Rubric clarity threshold excellent is not a level of its scale",
    "Qualitative requirement REQ-CLEAR names missing rubric (none)",
    "Scenario scenario declares concurrency with fewer than two lanes",
    "Scenario scenario declares contended input(s) race-a, race-b without concurrency lanes",
    "Scenario scenario watch input ghost is not a required input",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(found).toBe(true)
})

type FieldDeclaration = InputDeclaration["fields"][string]
type FieldDeclarations = InputDeclaration["fields"]
type StrategyDeclaration = Extract<FieldDeclaration, { readonly source: "native" }>["strategy"]

const native = (strategy: StrategyDeclaration): FieldDeclaration => ({ source: "native", strategy })
const accepted: InputDeclaration["outcome"] = { kind: "accepted" }
const validCase = (id: string, fields: FieldDeclarations): InputDeclaration => ({ id, operation: "ratings.rate", description: `Rate ${id}`, fields, validity: "native-valid", outcome: accepted })
const ratingApprovals = Array.append(currentApprovals, "cap@1")

const rating = (inputs: ReadonlyArray<InputDeclaration>) => DeclarationSchema.make({
  ...tiny,
  approvals: [{ ...approvalRecord, approves: ratingApprovals }],
  capabilities: [capability],
  stories: [{ ...story, capabilities: ["cap"] }],
  scenarios: [{ ...scenario, operations: ["ratings.rate"], inputs, required: Array.map(inputs, Struct.get("id")) }],
})

const ratedAs = (id: string) => (fields: FieldDeclarations) => {
  const input = validCase(id, fields)

  return rating([input])
}

const textBoundFields: FieldDeclarations = { rating: literal(2), score: literal(2), note: native("minimum") }
const unnullableFields: FieldDeclarations = { rating: literal(2), score: native("null"), note: literal("Plain") }
const outOfRangeFields: FieldDeclarations = { rating: literal(2), score: literal(9), note: literal("Too high") }
const mistypedFields: FieldDeclarations = { rating: literal(2), score: literal(2), note: literal(3) }

class TagUnavailable extends Schema.TaggedError<TagUnavailable>()("TagUnavailable", {}) {}

const confirmedOnly = (flag: boolean) => flag
const confirmedFilter = Schema.makeFilter(confirmedOnly)

// The confirmation carries a custom check without an arbitrary constraint because the interpreter cannot sample such a payload with bounded effort.
const ConfirmationSchema = Schema.Boolean.check(confirmedFilter)

const TagPayloadSchema = Schema.Struct({
  status: Schema.Literals(["open", "held", "closed"]),
  confirmed: ConfirmationSchema,
})

interface TagPayload extends Schema.Schema.Type<typeof TagPayloadSchema> {}

const tag = Command.family("tickets.", TagUnavailable).define({ name: "tag", payload: TagPayloadSchema, success: Schema.Boolean })

const tagHandler = Command.implement(tag, Effect.fn("CatalogTest.tag")(function* (payload: TagPayload) {
  return yield* Effect.succeed(payload.confirmed)
}))

const TicketCommands = Command.bundle(tagHandler)
const ticketPart = Part.command(TicketCommands)
const ticketDefinition = Application.define({ name: "catalog-ticket-test", parts: [ticketPart] })
const compiledTickets = Application.compile(ticketDefinition)

// The ticket application compiles synchronously because it is a pure definition without services.
const TicketApplication = Effect.runSync(compiledTickets)

const ticketFields: FieldDeclarations = { status: native("sample"), confirmed: literal(true) }
const ticketCase: InputDeclaration = { id: "tag", operation: "tickets.tag", description: "Tag a ticket", fields: ticketFields, validity: "native-valid", outcome: accepted }
const ticketCatalog = DeclarationSchema.make({ ...tiny, scenarios: [{ ...scenario, operations: ["tickets.tag"], inputs: [ticketCase], required: ["tag"] }] })

const unsupportedInterpretationTest = Effect.gen(function* () {
  const textBound = ratedAs("text-bound")(textBoundFields)
  const unnullable = ratedAs("unnullable")(unnullableFields)
  const outOfRange = ratedAs("out-of-range")(outOfRangeFields)
  const mistyped = ratedAs("mistyped")(mistypedFields)
  const messages = yield* Effect.forEach([textBound, unnullable, outOfRange, mistyped], rejection)
  const unsampled = validateCatalog(ticketCatalog, bindings, TicketApplication)
  const unsampleable = yield* Effect.flip(unsampled)

  const fragments = [
    "Scenario scenario input text-bound field note requests native minimum, which the interpreter cannot apply to ratings.rate.note: Native bound strategies need ratings.rate.note to be an untransformed number or nullable number",
    "Scenario scenario input unnullable field score requests native null, which the interpreter cannot apply to ratings.rate.score: Native null strategy needs ratings.rate.score to be an untransformed nullable field",
    "Scenario scenario input out-of-range field score declares a literal the native ratings.rate.score schema does not decode although the input is native-valid: ",
    "Scenario scenario input mistyped field note declares a literal the native ratings.rate.note schema does not decode although the input is native-valid: ",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(found).toBe(true)
  expect(unsampleable.message).toContain("Scenario scenario input tag field status requests native sample, which the interpreter cannot apply to tickets.tag.status: Native tickets.tag payload has a custom check without an arbitrary constraint")
})

const modelAssessed: RequirementDeclaration = { ...checkRequirement, id: "REQ-RATED", evaluator: "rubric-assessment" }
const offModelClear: RequirementDeclaration = { ...clearRequirement, evaluator: "check" }
const ratedApprovals = Array.append(currentApprovals, "REQ-RATED@1")

const evaluatorMismatchTest = Effect.gen(function* () {
  const modelObligation = DeclarationSchema.make({
    ...tiny,
    approvals: [{ ...approvalRecord, approves: ratedApprovals }],
    requirements: [checkRequirement, preserveRequirement, modelAssessed],
    stories: [{ ...story, requirements: ["REQ-CHECK", "REQ-PRESERVE", "REQ-RATED"] }],
    scenarios: [{ ...scenario, requirements: ["REQ-CHECK", "REQ-PRESERVE", "REQ-RATED"] }],
  })

  const offModelAssessment = withScenario(assessedScenario, [clarity], [checkRequirement, preserveRequirement, offModelClear])
  const messages = yield* Effect.forEach([modelObligation, offModelAssessment], rejection)

  const fragments = [
    "Scenario scenario references REQ-RATED as an obligation, but its evaluator rubric-assessment@1 is the model assessment, which never executes an obligation",
    "Scenario scenario assesses REQ-CLEAR, whose evaluator check@1 is not the model assessment rubric-assessment@1",
  ]

  const found = fragmentsFound(messages, fragments)

  expect(found).toBe(true)
})

it.effect("a contract-ready catalog binds local and qualified references exactly as authored", Function.constant(validCatalogTest))
it.effect("the platform obligations catalog validates as an approved, refinement-only shared obligation", Function.constant(platformCatalogTest))
it.effect("missing, obsolete, ambiguous, unknown-alias, duplicate, cyclic, and unapproved imports are rejected", Function.constant(importRejectionTest))
it.effect("refinements must bind exactly the referenced parameters and cannot cycle", Function.constant(refinementRejectionTest))
it.effect("only approved declarations with a current approval record are contract-ready", Function.constant(approvalRejectionTest))
it.effect("features, story contexts, and evaluator bindings are enforced", Function.constant(productRejectionTest))
it.effect("proposed qualitative requirements bind only as non-gating assessments and concurrent lanes validate", Function.constant(assessmentCatalogTest))
it.effect("qualitative obligations, unrated rubrics, single lanes, stray contended inputs, and unrequired watches are rejected", Function.constant(assessmentRejectionTest))
it.effect("native strategies and native-valid literals the native field cannot carry are rejected with scenario, input, field, and reason", Function.constant(unsupportedInterpretationTest))
it.effect("model-assessed obligations and assessments of non-model evaluators are rejected", Function.constant(evaluatorMismatchTest))
