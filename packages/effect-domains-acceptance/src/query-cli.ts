import { Array, Console, Effect, Equal, Function, Match, Option, Predicate, Record, Schema, String as Text, Struct, flow, pipe } from "effect"
import { join, resolve } from "node:path"
import { configurationFailure, parseOptions, reportFailure } from "./cli.ts"
import { AcceptanceError } from "./model.ts"

import {
  DocumentationView,
  GapView,
  ImpactView,
  ImplementationView,
  QaView,
  RequirementView,
  documentationView,
  gapView,
  impactView,
  implementationView,
  loadProduct,
  qaView,
  readEvidence,
  requirementView,
  stateSummary,
  type BuildEvidence,
  type CurrentBuild,
  type EvidenceScan,
  type InputSummary,
  type Journey,
  type JourneyStory,
  type OperationEntry,
  type OperationScenario,
  type Product,
  type QaScenario,
  type QueryApplication,
  type RecordedResult,
  type RequirementEntry,
  type ScopeEvidence,
  type UnreadableRun,
} from "./query.ts"

const ViewNameSchema = Schema.Literals(["requirements", "implementation", "qa", "documentation", "gaps", "impact"])
const OptionalTextSchema = Schema.OptionFromOptionalKey(Schema.String)

class QueryOptions extends Schema.Class<QueryOptions>("QueryOptions")({
  view: ViewNameSchema,
  application: Schema.String,
  evidence: Schema.String,
  changed: OptionalTextSchema,
  operation: OptionalTextSchema,
  requirement: OptionalTextSchema,
  json: Schema.Boolean,
}) {}

class RenderedView extends Schema.Class<RenderedView>("RenderedView")({
  text: Schema.String,
  json: Schema.Unknown,
}) {}

const queryOptionNames = ["--application", "--evidence", "--changed", "--operation", "--requirement"]
const jsonFlag = "--json"
const allApplications = "all"
const indent = "  "
const nested = "    "
const deeper = "      "
const none = [`${indent}none`]

const isJsonFlag = (arg: string) => Equal.equals(arg, jsonFlag)
const lines = Array.join("\n")
const listed = (values: ReadonlyArray<string>) => Array.isReadonlyArrayNonEmpty(values) ? Array.join(values, ", ") : "none"
const indented = (prefix: string) => (line: string) => `${prefix}${line}`
const short = Text.slice(0, 12)
const orNone = (body: ReadonlyArray<string>) => Array.isReadonlyArrayNonEmpty(body) ? body : none

const defaultEvidence = () => {
  const root = new URL("../../../", import.meta.url).pathname

  return join(root, "data", "acceptance")
}

const viewError = (error: Schema.SchemaError) => configurationFailure(`Unknown view; use requirements|implementation|qa|documentation|gaps|impact (${error.message})`)

const decodeView = flow(Schema.decodeUnknownEffect(ViewNameSchema), Effect.mapError(viewError))

const readOptions = Effect.fn("Acceptance.query.readOptions")(function* (args: ReadonlyArray<string>) {
  const json = Array.some(args, isJsonFlag)
  const rest = Array.filter(args, Predicate.not(isJsonFlag))
  const view = yield* pipe(rest, Array.head, Option.getOrElse(Function.constant("")), decodeView)
  const pairs = Array.drop(rest, 1)
  const options = yield* parseOptions(queryOptionNames, pairs)
  const option = (name: string) => Record.get(options, name)
  const evidence = pipe(option("--evidence"), Option.map(resolve), Option.getOrElse(defaultEvidence))
  const application = pipe(option("--application"), Option.getOrElse(Function.constant(allApplications)))

  return QueryOptions.make({
    view,
    application,
    evidence,
    changed: option("--changed"),
    operation: option("--operation"),
    requirement: option("--requirement"),
    json,
  })
})

const modeText = (mode: string) => `, ${mode}`

const latestText = (latest: RecordedResult) => {
  const unfinished = latest.finished ? "" : ", unfinished run"
  const reasons = Array.join(latest.staleness, "; ")
  const staleness = Array.isReadonlyArrayNonEmpty(latest.staleness) ? `; ${reasons}` : ""
  const mode = pipe(latest.mode, Option.map(modeText), Option.getOrElse(Function.constant("")))
  const repaired = latest.repairs > 0 ? `, ${latest.repairs} locator repair(s)` : ""

  return ` (newest ${latest.run} ${latest.startedAt}: ${latest.status}${mode}${repaired}${unfinished}${staleness})`
}

const scopeLine = (evidence: ScopeEvidence) => {
  const { scope } = evidence
  const latest = pipe(evidence.latest, Option.map(latestText), Option.getOrElse(Function.constant("")))

  return `${scope.scenario}@${scope.scenarioRevision} via ${scope.evaluator}@${scope.evaluatorRevision}: ${evidence.state}${latest}`
}

const buildLine = (build: BuildEvidence) => {
  const current = build.current ? " (current build)" : ""
  const statuses = Array.join(build.statuses, ", ")
  const hash = short(build.build)

  return `${hash}${current} ${build.run} ${build.startedAt}: ${statuses}`
}

const unreadableLine = (entry: UnreadableRun) => `${indent}${entry.path}: ${entry.problem}`

const unreadableSection = (entries: ReadonlyArray<UnreadableRun>) => {
  const described = Array.map(entries, unreadableLine)

  return Array.isReadonlyArrayNonEmpty(described) ? ["Unreadable runs (not counted):", ...described] : Array.empty<string>()
}

const optionalLine = (label: string) => flow(Option.map(indented(`${indent}${label}: `)), Option.toArray)

const requirementBlock = (entry: RequirementEntry) => {
  const refiners = Array.join(entry.refinedBy, ", ")
  const refinedBy = Array.isReadonlyArrayNonEmpty(entry.refinedBy) ? [`${indent}refined by: ${refiners}`] : Array.empty<string>()
  const scopes = Array.map(entry.scopes, flow(scopeLine, indented(nested)))
  const builds = Array.map(entry.builds, flow(buildLine, indented(nested)))
  const evaluator = optionalLine("evaluator")(entry.evaluator)
  const refines = optionalLine("refines")(entry.refines)
  const stories = listed(entry.stories)
  const counts = stateSummary(entry.scopes)
  const buildLines = Array.isReadonlyArrayNonEmpty(builds) ? builds : [`${nested}none`]

  return [
    `${entry.reference}@${entry.revision} [${entry.category}] owner ${entry.owner}`,
    `${indent}text: ${entry.text}`,
    ...evaluator,
    ...refines,
    ...refinedBy,
    `${indent}stories: ${stories}`,
    `${indent}implementation: ${entry.implementation.state} — ${entry.implementation.detail}`,
    `${indent}tested conformance: ${entry.conformance.state} — ${entry.conformance.summary}`,
    `${indent}validated user benefit: ${entry.benefit}`,
    `${indent}exercised scopes (${counts}):`,
    ...scopes,
    `${indent}latest evidence per build:`,
    ...buildLines,
  ]
}

const heading = (application: string, title: string, current: CurrentBuild) => {
  const build = short(current.sha256)
  const hash = short(current.catalogHash)

  return `== ${application}: ${title} (current build ${build}, catalog hash ${hash})`
}

const requirementsText = (view: RequirementView) => {
  const title = heading(view.application, "requirements", view.current)
  const blocks = Array.flatMap(view.entries, requirementBlock)
  const unreadable = unreadableSection(view.unreadable)

  return lines([title, ...blocks, ...unreadable])
}

const inputLines = (input: InputSummary) => {
  const fields = Array.map(input.fields, indented(`${deeper}${indent}`))

  return [`${deeper}input ${input.id}: ${input.validity} → ${input.outcome}`, ...fields]
}

const scopeState = (evidence: ScopeEvidence) => `${evidence.scope.requirement}=${evidence.state}`

const operationScenarioLines = (scenario: OperationScenario) => {
  const inputs = Array.flatMap(scenario.inputs, inputLines)
  const states = pipe(scenario.scopes, Array.map(scopeState), listed)

  return [`${nested}${scenario.scenario} (story ${scenario.story})`, ...inputs, `${deeper}requirements: ${states}`]
}

const operationBlock = (entry: OperationEntry) => {
  const native = entry.native ? "native" : "not in the native contract"
  const unbound = Array.isReadonlyArrayEmpty(entry.capabilities)
  const requirements = Array.map(entry.requirements, indented(nested))
  const scenarios = Array.flatMap(entry.scenarios, operationScenarioLines)
  const capabilities = listed(entry.capabilities)
  const features = listed(entry.features)
  const stories = listed(entry.stories)

  if (unbound) return [`${entry.operation} [${native}] — no recorded capability, requirement, or scenario binding`]

  return [
    `${entry.operation} [${native}]`,
    `${indent}capabilities: ${capabilities}`,
    `${indent}features: ${features}`,
    `${indent}stories: ${stories}`,
    `${indent}requirements:`,
    ...requirements,
    `${indent}scenarios and inputs:`,
    ...scenarios,
  ]
}

const implementationText = (view: ImplementationView) => {
  const title = heading(view.application, "implementation bindings", view.current)
  const blocks = Array.flatMap(view.operations, operationBlock)

  return lines([title, ...blocks])
}

const qaScenarioLines = (scenario: QaScenario) => {
  const reasons = Array.map(scenario.reasons, indented(`${nested}- `))

  return [`${indent}${scenario.scenario} (story ${scenario.story})`, ...reasons]
}

const qaSection = (title: string) => (scenarios: ReadonlyArray<QaScenario>) => {
  const count = Array.length(scenarios)
  const body = Array.flatMap(scenarios, qaScenarioLines)
  const shown = orNone(body)

  return [`${title} (${count}):`, ...shown]
}

const qaText = (view: QaView) => {
  const title = heading(view.application, "QA", view.current)
  const needing = qaSection("Needing a run for the current build")(view.needingRun)
  const failing = qaSection("Failing on the current build")(view.failing)
  const unreadable = unreadableSection(view.unreadable)
  const assessments = bulleted(view.assessments)
  const assessmentCount = Array.length(view.assessments)
  const assessmentTitle = `Non-gating model assessments (${assessmentCount}; never counted as passes):`

  return lines([title, view.summary, ...needing, ...failing, assessmentTitle, ...assessments, ...unreadable])
}

const bulleted = Array.map(indented(`${deeper}- `))

const storyLines = (story: JourneyStory) => {
  const capabilities = bulleted(story.capabilities)
  const requirements = bulleted(story.requirements)
  const scenarios = bulleted(story.scenarios)
  const nonGoals = listed(story.nonGoals)

  return [
    `${indent}Story ${story.story}: "${story.original}"`,
    `${nested}context: ${story.context}`,
    `${nested}need: ${story.need}`,
    `${nested}capabilities:`,
    ...capabilities,
    `${nested}requirements:`,
    ...requirements,
    `${nested}scenarios:`,
    ...scenarios,
    `${nested}non-goals: ${nonGoals}`,
  ]
}

const journeyLines = (journey: Journey) => {
  const stories = Array.flatMap(journey.stories, storyLines)

  return [`Actor ${journey.actor} — ${journey.description}`, ...stories]
}

const documentationText = (view: DocumentationView) => {
  const title = heading(view.application, `${view.title} role-centred journeys`, view.current)
  const journeys = Array.flatMap(view.journeys, journeyLines)

  return lines([title, ...journeys, "Scenario states are tested conformance on the current build only; validated user benefit is never inferred from passes."])
}

const section = (title: string) => (values: ReadonlyArray<string>) => {
  const body = Array.map(values, indented(`${indent}- `))
  const shown = orNone(body)

  return [`${title}:`, ...shown]
}

type Partition = GapView["partitions"][number]

const partitionLines = (partition: Partition) => {
  const overlaps = Array.map(partition.overlaps, indented(`${nested}overlap: `))
  const members = Array.map(partition.unexercisedMembers, indented(`${nested}enum gap: `))
  const boundaries = Array.map(partition.boundaries, indented(`${nested}boundaries: `))
  const details = [...overlaps, ...members, ...boundaries]
  const shown = Array.isReadonlyArrayNonEmpty(details) ? details : [`${nested}no overlap, enumerated, or bounded field to report`]

  return [`${indent}${partition.operation} (${partition.inputCases} input case(s))`, ...shown]
}

const gapsText = (view: GapView) => {
  const capabilities = section("Capabilities without a need (no story links them)")(view.capabilitiesWithoutNeed)
  const needs = section("Needs without capabilities")(view.needsWithoutCapabilities)
  const requirements = section("Requirements without scenarios")(view.requirementsWithoutScenarios)
  const stories = section("Stories without scenarios")(view.storiesWithoutScenarios)
  const operations = section("Native operations without a capability")(view.operationsWithoutCapability)
  const refinements = section("Refinements of shared obligations")(view.refinements)
  const shared = section("Shared obligations neither refined nor exercised")(view.unrefinedShared)
  const partitions = Array.flatMap(view.partitions, partitionLines)
  const partitionTitle = `Partition coverage per operation (${view.partitionScope}):`

  return lines([`== ${view.application}: gaps`, ...capabilities, ...needs, ...requirements, ...stories, ...operations, ...refinements, ...shared, partitionTitle, ...partitions])
}

const impactText = (view: ImpactView) => {
  const unmatched = Array.isReadonlyArrayEmpty(view.matches)
  const notice = `No recorded declaration, operation, evaluator, or fixture matches ${view.changed}; this is not a "no impact" result.`
  const matches = section("Matched")(view.matches)
  const matched = unmatched ? [notice] : matches
  const declarations = section("Dependent declarations")(view.declarations)
  const scenarios = section("Candidate scenarios to re-run")(view.scenarios)
  const runs = section("Candidate retained runs covering them")(view.runs)

  return lines([`== ${view.application}: change impact candidates for ${view.changed}`, view.caveat, ...matched, ...declarations, ...scenarios, ...runs])
}

const encodingFailure = (error: Schema.SchemaError) => AcceptanceError.make({ boundary: "query", message: error.message })

const rendered = <A, I>(schema: Schema.Codec<A, I>, text: (view: A) => string) => (view: A) => {
  const toView = (json: I) => RenderedView.make({ text: text(view), json })

  return pipe(view, Schema.encodeEffect(schema), Effect.mapError(encodingFailure), Effect.map(toView))
}

const missingChange = configurationFailure("impact requires --changed <declaration id | operation | evaluator>")

const impactOutput = (changed: Option.Option<string>) => (product: Product) => pipe(
  changed,
  Effect.fromOption,
  Effect.mapError(Function.constant(missingChange)),
  Effect.map(flow(impactView, Function.apply(product))),
  Effect.flatMap(rendered(ImpactView, impactText)),
)

const renderView = (options: QueryOptions) => pipe(
  Match.value(options.view),
  Match.when("requirements", Function.constant(flow(requirementView(options.requirement), rendered(RequirementView, requirementsText)))),
  Match.when("implementation", Function.constant(flow(implementationView(options.operation), rendered(ImplementationView, implementationText)))),
  Match.when("qa", Function.constant(flow(qaView, rendered(QaView, qaText)))),
  Match.when("documentation", Function.constant(flow(documentationView, rendered(DocumentationView, documentationText)))),
  Match.when("gaps", Function.constant(flow(gapView, rendered(GapView, gapsText)))),
  Match.when("impact", Function.constant(impactOutput(options.changed))),
  Match.exhaustive,
)

const named = (name: string) => (application: QueryApplication) => Equal.equals(application.definition.name, name)

const selectApplications = (applications: ReadonlyArray<QueryApplication>, name: string) => {
  const names = pipe(applications, Array.map(flow(Struct.get("definition"), Struct.get("name"))), Array.join("|"))
  const everything = Equal.equals(name, allApplications)
  const chosen = everything ? applications : Array.filter(applications, named(name))
  const unknown = configurationFailure(`Unknown application ${name}; use ${names}|${allApplications}`)

  return Array.isReadonlyArrayNonEmpty(chosen) ? Effect.succeed(chosen) : Effect.fail(unknown)
}

const productOf = (scan: EvidenceScan) => (application: QueryApplication) => loadProduct(application, scan)

const printText = flow(Array.map(Struct.get<RenderedView, "text">("text")), Array.join("\n\n"), Console.log)

const printJson = (views: ReadonlyArray<RenderedView>) => {
  const entries = Array.map(views, Struct.get("json"))
  const text = JSON.stringify(entries, null, 2)

  return Console.log(text)
}

const query = Effect.fn("Acceptance.query.main")(function* (applications: ReadonlyArray<QueryApplication>, args: ReadonlyArray<string>) {
  const options = yield* readOptions(args)
  const selected = yield* selectApplications(applications, options.application)
  const scan = yield* readEvidence(options.evidence)
  const products = yield* Effect.forEach(selected, productOf(scan))
  const render = renderView(options)
  const views = yield* Effect.forEach(products, render)

  return yield* options.json ? printJson(views) : printText(views)
})

const commandLine = Effect.sync(() => process.argv)

/** The query command line is shared because every consumer reads the same approved catalogs and retained evidence through one interface. */
export const runQueryCli = Effect.fn("Acceptance.runQueryCli")(function* (applications: ReadonlyArray<QueryApplication>, help: string) {
  const argv = yield* commandLine
  const args = Array.drop(argv, 2)
  const wantsHelp = Array.contains(argv, "--help")

  if (wantsHelp) return yield* Console.log(help)

  return yield* pipe(query(applications, args), Effect.catch(reportFailure))
})
