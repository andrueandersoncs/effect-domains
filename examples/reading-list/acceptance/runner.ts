import { Clock, Effect, Result, Schema } from "effect"
import { join } from "node:path"
import { browserLayer } from "./browser.ts"
import { validateCatalog, readingListCatalog } from "./catalog.ts"
import { directory, buildIdentity, RunEvidence } from "./evidence.ts"
import { evaluationLayer, evaluatorNames, verifyDefects } from "./evaluation.ts"
import { prepareFixture, fixtureRevision } from "./fixture.ts"
import { makeCandidate, replayCandidate } from "./inputs.ts"
import { jevLayer } from "./jev.ts"
import { AcceptanceError, BrowserSurface, DecisionModel, PayloadSchema, RequirementEvaluation, ScenarioSchema, type Action, type Candidate, type Decision, type Observation, type Payload, type RequirementResult, type Scenario, type Submission } from "./model.ts"

const ActionSchema = Schema.Struct({ id: Schema.String, description: Schema.String, kind: Schema.Literals(["open", "fill", "submit", "reload", "observe", "cannot-proceed"]), operation: Schema.optionalKey(Schema.String), path: Schema.optionalKey(Schema.String), value: Schema.optionalKey(Schema.Unknown), target: Schema.String, snapshot: Schema.String })
const CandidateSchema = Schema.Struct({ input: PayloadSchema, decoded: Schema.optionalKey(Schema.Unknown), source: Schema.String, seed: Schema.Int, strategy: Schema.String, valid: Schema.Boolean, nativeValidation: Schema.String, omittedFields: Schema.Array(Schema.String) })
const ReplayScenarioSchema = Schema.Struct({ scenario: ScenarioSchema, candidate: CandidateSchema, trace: Schema.Array(Schema.Struct({ action: ActionSchema, executed: Schema.Boolean })) })
const ReplaySchema = Schema.Struct({ format: Schema.Literal("reading-list-acceptance@1"), build: Schema.Struct({ sha256: Schema.String, catalogHash: Schema.String, nativeContractsHash: Schema.String }), scenarios: Schema.Array(ReplayScenarioSchema) })
type ReplayScenario = Schema.Schema.Type<typeof ReplayScenarioSchema>
export type RunConfiguration = Readonly<{ output: string; seed: number; model: string; minimumConfidence: number; maxActions: number; deadlineSeconds: number; replay?: string; apiKey?: string }>
type TraceEntry = Readonly<{ at: string; action: Action; executed: boolean; decision?: Decision; observation: Observation }>
type ScenarioRun = Readonly<{ scenario: Scenario; candidate: Candidate; actor: string; fixtureRevision: string; sentinel: Payload; target?: Payload; created?: Payload; before: Observation; after: Observation; submission?: Submission; trace: ReadonlyArray<TraceEntry>; results: ReadonlyArray<RequirementResult>; interruption?: string; actionCompletion: boolean }>

const executeScenario = Effect.fn("Acceptance.executeScenario")(function* (scenario: Scenario, candidate: Candidate, fixture: Readonly<{ sentinel: Payload; target?: Payload }>, artifacts: string, configuration: RunConfiguration, replay?: ReplayScenario) {
  const surface = yield* BrowserSurface
  const evaluator = yield* RequirementEvaluation
  const before = yield* surface.observe(false, join(artifacts, "before.png"))
  let after = before
  let submission: Submission | undefined
  let created: Payload | undefined
  let reloaded = false
  let interruption: string | undefined
  const trace: TraceEntry[] = []
  const repeated: Record<string, number> = {}
  const interaction = Effect.gen(function* () {
    for (let step = 0; step < configuration.maxActions; step++) {
      const options = yield* surface.actions(scenario, candidate, submission !== undefined, reloaded)
      let action: Action | undefined
      let decision: Decision | undefined
      if (replay) {
        const recordedEntry = replay.trace[step]
        const recorded = recordedEntry?.action
        if (!recorded) return yield* new AcceptanceError({ boundary: "replay", message: "Recorded actions exhausted before obligations were exercised" })
        const recordedInput = recorded.kind === "fill"
          ? yield* Schema.decodeUnknownEffect(PayloadSchema)(recorded.value).pipe(Effect.mapError((error) => new AcceptanceError({ boundary: "replay", message: `Invalid recorded payload action: ${error}` })))
          : undefined
        const value = recordedInput && scenario.operation === "books.update" && fixture.target
          ? { ...recordedInput, id: fixture.target.id }
          : recordedInput ?? recorded.value
        action = options.find((option) => option.id === recorded.id && option.kind === recorded.kind && option.operation === recorded.operation && option.path === recorded.path && option.target === recorded.target && JSON.stringify(option.value) === JSON.stringify(value))
        if (!action) return yield* new AcceptanceError({ boundary: "replay", message: `Recorded action ${recorded.id} is no longer available; original failure retained, no locator repair or skipped criterion` })
        if (!recordedEntry?.executed) {
          trace.push({ at: new Date(yield* Clock.currentTimeMillis).toISOString(), action, executed: false, observation: after })
          return yield* new AcceptanceError({ boundary: "replay", message: `Recorded action ${recorded.id} was not executed; original interruption is preserved` })
        }
      } else {
        const model = yield* DecisionModel
        decision = yield* model.choose(scenario.goal, { mode: "internally-guided-functional", operation: scenario.operation, candidate: candidate.input, expected: scenario.expected, submissionComplete: submission !== undefined, reloadRequired: scenario.reload, reloadComplete: reloaded, view: { loaded: after.loaded, resource: after.resource, rows: after.rows.map((row) => ({ id: row.id, title: row.title, rating: row.rating })) } }, options, trace.map((entry) => entry.action.description))
        action = options.find((option) => option.id === decision?.choice)
      }
      if (!action) return yield* new AcceptanceError({ boundary: "decision", message: "Decision selected no available action" })
      const chosen = action
      const entryTime = new Date(yield* Clock.currentTimeMillis).toISOString()
      trace.push({ at: entryTime, action: chosen, executed: false, ...(decision ? { decision } : {}), observation: after })
      if (decision && decision.confidence < configuration.minimumConfidence) {
        return yield* new AcceptanceError({ boundary: "decision", message: `Confidence ${decision.confidence} is below configured ${configuration.minimumConfidence}; action not executed` })
      }
      if (chosen.kind === "cannot-proceed") {
        return yield* new AcceptanceError({ boundary: "decision", message: "Decision chose cannot-proceed" })
      }
      const fingerprint = JSON.stringify([chosen.kind, chosen.operation, chosen.path, chosen.value, chosen.target])
      repeated[fingerprint] = (repeated[fingerprint] ?? 0) + 1
      if (repeated[fingerprint] > 2) return yield* new AcceptanceError({ boundary: "progress", message: `Repeated action without completion: ${chosen.id}` })
      const outcome = yield* surface.execute(chosen)
      trace[trace.length - 1] = { ...trace[trace.length - 1]!, executed: true }
      if (outcome) {
        if (submission) return yield* new AcceptanceError({ boundary: "scope", message: "Scenario attempted more than one submission" })
        submission = outcome
        if (scenario.operation === "books.create" && outcome.status >= 200 && outcome.status < 300) {
          const value = Schema.decodeUnknownOption(PayloadSchema)(outcome.result)
          if (value._tag === "Some") created = value.value
        }
      }
      if (chosen.kind === "reload") reloaded = true
      after = yield* surface.observe(reloaded, join(artifacts, `step-${step + 1}.png`))
      trace[trace.length - 1] = { at: entryTime, action: chosen, executed: true, ...(decision ? { decision } : {}), observation: after }
      if (submission && after.loaded && (!scenario.reload || reloaded)) return
    }
    return yield* new AcceptanceError({ boundary: "deadline", message: `Action limit ${configuration.maxActions} exhausted` })
  })
  const outcome = yield* Effect.result(interaction.pipe(Effect.timeout(`${configuration.deadlineSeconds} seconds`)))
  if (Result.isFailure(outcome)) interruption = String(outcome.failure)
  const evidence = [join(artifacts, "scenario.json"), before.screenshot ?? join(artifacts, "before.png"), ...(after.screenshot ? [after.screenshot] : [])]
  const results: RequirementResult[] = []
  for (const id of scenario.requirements) {
    const requirement = readingListCatalog.requirements.find((item) => item.id === id)
    if (!requirement) return yield* new AcceptanceError({ boundary: "catalog", message: `Missing resolved requirement ${id}` })
    const evaluation = yield* Effect.result(evaluator.evaluate(requirement, { scenario, candidate, before, after, sentinel: fixture.sentinel, ...(fixture.target ? { target: fixture.target } : {}), ...(created ? { created } : {}), ...(submission ? { submission } : {}), ...(interruption ? { interruption } : {}), evidence }))
    results.push(Result.isSuccess(evaluation) ? evaluation.success : { requirement: requirement.id, requirementRevision: requirement.revision, scenario: scenario.id, scenarioRevision: scenario.revision, evaluator: requirement.evaluator, evaluatorRevision: requirement.evaluatorRevision, basis: "executable assertion", status: "inconclusive", explanation: `Evaluator failed: ${evaluation.failure}`, evidence })
  }
  return { scenario, candidate, actor: "public-reader", fixtureRevision, sentinel: fixture.sentinel, ...(fixture.target ? { target: fixture.target } : {}), ...(created ? { created } : {}), before, after, ...(submission ? { submission } : {}), trace, results, ...(interruption ? { interruption } : {}), actionCompletion: submission !== undefined && after.loaded && (!scenario.reload || reloaded) } satisfies ScenarioRun
})

export const runAcceptance = Effect.fn("Acceptance.run")(function* (configuration: RunConfiguration) {
  const catalog = yield* validateCatalog(readingListCatalog, evaluatorNames)
  const output = yield* directory(configuration.output)
  const alreadyExists = yield* Effect.tryPromise({ try: () => Bun.file(join(output, "run.json")).exists(), catch: (error) => new AcceptanceError({ boundary: "evidence", message: String(error) }) })
  if (alreadyExists) return yield* new AcceptanceError({ boundary: "evidence", message: "Output already contains run.json; choose a fresh directory to preserve previous evidence" })
  const evidence = yield* RunEvidence
  const build = yield* buildIdentity(catalog)
  const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
  const replay = configuration.replay ? yield* Effect.tryPromise({
    try: async () => Schema.decodeUnknownSync(ReplaySchema)(await Bun.file(configuration.replay!).json()),
    catch: (error) => new AcceptanceError({ boundary: "replay", message: String(error) }),
  }) : undefined
  if (replay && (replay.build.sha256 !== build.sha256 || replay.build.catalogHash !== build.catalogHash || replay.build.nativeContractsHash !== build.nativeContractsHash)) return yield* new AcceptanceError({ boundary: "replay", message: "Replay is stale against application, catalog, evaluator, browser bindings, or native contracts; no semantic repair is automatic" })
  if (replay && (replay.scenarios.length !== catalog.scenarios.length || catalog.scenarios.some((scenario) => replay.scenarios.filter((item) => item.scenario.id === scenario.id && item.scenario.revision === scenario.revision).length !== 1))) return yield* new AcceptanceError({ boundary: "replay", message: "Replay lacks exact scenario coverage" })
  if (!replay && !configuration.apiKey) return yield* new AcceptanceError({ boundary: "decision", message: "TYPESAFE_API_KEY is required for real Jev exploration (never a mock fallback)" })
  const defects = yield* verifyDefects().pipe(Effect.provide(evaluationLayer))
  yield* evidence.save(join(output, "verifier.json"), defects)
  const scenarios: ScenarioRun[] = []
  const retainedConfiguration = { model: configuration.model, minimumConfidence: configuration.minimumConfidence, maxActions: configuration.maxActions, deadlineSeconds: configuration.deadlineSeconds, seed: configuration.seed, browser: { engine: "chromium", playwright: "1.64.0", viewport: { width: 1280, height: 900 }, context: "fresh-per-scenario" }, mode: replay ? "recorded-replay" : "real-jev-exploration", sourceReplay: configuration.replay ?? null }
  const report = () => ({ format: "reading-list-acceptance@1", startedAt, catalog, build, fixtureRevision, configuration: retainedConfiguration, scenarios, verifier: defects, fullSystemCompletion: false, ledger: { advanced: ["SDA-01", "SDA-02", "SDA-03", "SDA-04", "SDA-05", "SDA-06", "SDA-07", "SDA-08", "SDA-09", "SDA-12"], closed: [], unexercised: ["SDA-10", "SDA-11"] }, coverage: catalog.scenarios.flatMap((scenario) => scenario.requirements.map((id) => ({ requirement: id, scenario: scenario.id, result: scenarios.find((run) => run.scenario.id === scenario.id)?.results.find((result) => result.requirement === id)?.status ?? "missing" }))) })
  yield* evidence.save(join(output, "run.json"), report())
  for (let index = 0; index < catalog.scenarios.length; index++) {
    const scenario = catalog.scenarios[index]!
    const artifacts = yield* directory(join(output, encodeURIComponent(scenario.id)))
    const recorded = replay?.scenarios.find((item) => item.scenario.id === scenario.id)
    const execution = Effect.scoped(Effect.gen(function* () {
      const fixture = yield* prepareFixture(scenario, artifacts)
      const candidate = recorded ? yield* replayCandidate(scenario, { ...recorded.candidate, decoded: recorded.candidate.decoded }, fixture.target) : yield* makeCandidate(scenario, configuration.seed + index, fixture.target)
      return yield* executeScenario(scenario, candidate, fixture, artifacts, configuration, recorded).pipe(Effect.provide(browserLayer({ url: fixture.url, artifacts })), Effect.provide(evaluationLayer), Effect.provide(jevLayer({ apiKey: configuration.apiKey ?? "", model: configuration.model })))
    }))
    const result = yield* Effect.result(execution)
    if (Result.isSuccess(result)) {
      scenarios.push(result.success)
      yield* evidence.save(join(artifacts, "scenario.json"), result.success)
    } else {
      const empty: Observation = { loaded: false, resource: "books", unfiltered: false, rows: [], reloaded: false }
      const failed: ScenarioRun = { scenario, candidate: { input: {}, decoded: undefined, source: "prerequisite-not-resolved", seed: configuration.seed + index, strategy: scenario.strategy, valid: false, nativeValidation: "not exercised", omittedFields: [] }, actor: "public-reader", fixtureRevision, sentinel: {}, before: empty, after: empty, trace: [], interruption: String(result.failure), actionCompletion: false, results: scenario.requirements.map((id) => {
        const requirement = catalog.requirements.find((item) => item.id === id)!
        return { requirement: id, requirementRevision: requirement.revision, scenario: scenario.id, scenarioRevision: scenario.revision, evaluator: requirement.evaluator, evaluatorRevision: requirement.evaluatorRevision, basis: "executable assertion", status: "blocked", explanation: `Scenario prerequisite failed: ${result.failure}`, evidence: [join(artifacts, "server.stderr.log")] }
      }) }
      scenarios.push(failed)
      yield* evidence.save(join(artifacts, "scenario.json"), failed)
    }
    yield* evidence.save(join(output, "run.json"), report())
    yield* Effect.logInfo(`${scenario.id}: ${scenarios[scenarios.length - 1]!.results.map((result) => `${result.requirement}=${result.status}`).join(", ")}`)
  }
  const passed = scenarios.length === catalog.scenarios.length && scenarios.every((scenario) => scenario.actionCompletion && scenario.results.every((result) => result.status === "pass")) && defects.summary.falseAcceptance === 0 && defects.summary.falseRejection === 0 && defects.summary.unexpectedStatuses === 0
  const finished = { ...report(), finishedAt: new Date(yield* Clock.currentTimeMillis).toISOString(), sliceStatus: passed ? "pass" : "not-passed" }
  yield* evidence.save(join(output, "run.json"), finished)
  yield* Effect.logInfo(`Slice A ${finished.sliceStatus}; evidence ${join(output, "run.json")}; SDA-01–SDA-12 remain open`)
  return passed
})
