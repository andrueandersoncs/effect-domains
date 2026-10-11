import { expect, it } from "@effect/vitest"
import { Array, DateTime, Effect, Equal, Function, Option, Redacted, Schema, String as Text, Struct, flow, pipe } from "effect"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  EvidencePolicy,
  LineageBuild,
  LineageFacts,
  LineageResult,
  type PrunePlan,
  ProtectedOperation,
  ProtectedProbe,
  type ReplaySource,
  claimOwnership,
  classify,
  exportRun,
  inspect,
  localRules,
  prune,
  recordLineage,
  redactJson,
  replaySource,
  seal,
  sealFindings,
  unrelatedProtectedRecords,
  validatePolicy,
} from "./governance.ts"

import { scopedTemporaryDirectory } from "./server.ts"

const auditProbe = ProtectedProbe.make({ probe: "audit-trail", identity: "id", reason: "administrator-only audit records" })

const auditOperation = ProtectedOperation.make({ operation: "support.auditTrail", identity: "id", reason: "administrator-only audit records" })

const policy = EvidencePolicy.make({
  application: "governance-test",
  revision: "governance-test-evidence@1",
  scope: "local-only",
  protectedProbes: [auditProbe],
  protectedOperations: [auditOperation],
  rules: localRules,
})

const sentinelRecord = "support-case:sentinel-case:1"

const targetRecord = "support-case:target-case:1"

const password = "generated-password-value-0123456789"

const auditRecords = (subject: string, id: string) => [{ id, action: "open", targetId: subject }]

const ScenarioReportSchema = Schema.Record(Schema.String, Schema.Unknown)

const scenarioReport = (rows: ReadonlyArray<unknown>) => ScenarioReportSchema.make({
  fixture: { facts: { "target.id": "target-case", "sentinel.case.id": "sentinel-case" } },
  candidates: [{ inputCase: "read-audit", operation: "support.auditTrail", input: { caseId: "target-case" } }],
  submissions: [{ inputCase: "read-audit", operation: "support.auditTrail", input: { caseId: "target-case" }, status: 200, result: auditRecords("target-case", targetRecord), at: "t" }],
  before: [{ operation: "support_cases.list", resource: "support_cases", loaded: true, unfiltered: true, complete: true, rows, reloaded: false }],
  after: [],
  trace: [{ at: "t", executed: true, decision: { choice: "a", confidence: 0.9, probabilities: {}, model: "jev", request: { state: "visible rows" }, response: { answer: "a" } } }],
  probes: [
    { probe: "audit-trail", phase: "before", subject: "sentinel-case", actor: "fixture-admin-probe", at: "t", status: 200, result: auditRecords("sentinel-case", sentinelRecord) },
    { probe: "audit-trail", phase: "before", subject: "target-case", actor: "fixture-admin-probe", at: "t", status: 200, result: auditRecords("target-case", targetRecord) },
    { probe: "case-detail", phase: "before", subject: "sentinel-case", actor: "fixture-public-probe", at: "t", status: 200, result: { id: "sentinel-case" } },
  ],
  results: [{ requirement: "audit", status: "pass" }],
  session: { token: "issued-session-token" },
})

const cleanRun = scenarioReport([{ id: "target-case", subject: "Password reset" }])

const temporaryDirectory = scopedTemporaryDirectory("effect-domains-acceptance-governance-")

const textFile = (path: string, content: string | Uint8Array) => Effect.tryPromise(() => writeFile(path, content))

const makeDirectory = (path: string) => Effect.tryPromise(() => mkdir(path, { recursive: true }))

const listDirectory = (path: string) => Effect.tryPromise(() => readdir(path))

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const contains = (text: string, part: string) => Text.includes(part)(text)

const startedAt = "2026-01-01T00:00:00.000Z"

const lineageFacts = (replay: Option.Option<ReplaySource>) => LineageFacts.make({
  finishedAt: startedAt,
  status: "pass",
  build: LineageBuild.make({ sha256: "build", catalogHash: "catalog", nativeContractsHash: "contracts", importedCatalogs: [] }),
  catalog: "governance-catalog",
  catalogRevision: "1",
  imports: [],
  results: [LineageResult.make({ scope: "audit", requirement: "audit", status: "pass" })],
  replaySource: replay,
  repair: Option.none(),
})

const noReplay = Option.none<ReplaySource>()

const unsourcedFacts = lineageFacts(noReplay)

const pngBytes = new Uint8Array([137, 80, 78, 71])

const writeRun = Effect.fn("GovernanceTest.writeRun")(function* (directory: string, run: unknown, log: string) {
  const scenario = join(directory, "audit")
  const runPath = join(directory, "run.json")
  const scenarioPath = join(scenario, "scenario.json")
  const screenshotPath = join(scenario, "step-1.png")
  const logPath = join(scenario, "server.stdout.log")
  const runJson = json({ scenarios: [run] })
  const scenarioJson = json(run)

  yield* makeDirectory(scenario)
  yield* textFile(runPath, runJson)
  yield* textFile(scenarioPath, scenarioJson)
  yield* textFile(screenshotPath, pngBytes)
  yield* textFile(logPath, log)
})

const ownedRun = Effect.fn("GovernanceTest.ownedRun")(function* (directory: string, run: unknown, log: string) {
  const marker = yield* claimOwnership(directory, policy, "exploration", startedAt)

  yield* writeRun(directory, run, log)

  return marker
})

const passwordSecret = Redacted.make(password)

const secrets = [passwordSecret]

const apiKey = Option.some(passwordSecret)

const noKey = Option.none<Redacted.Redacted<string>>()

const scenarioFile = Option.some("audit/scenario.json")

const wholeDirectory = Option.none<string>()

const classifyLocal = classify(localRules)

const redactionTest = Effect.gen(function* () {
  const qa = redactJson(policy, "qa")(cleanRun)
  const text = JSON.stringify(qa)
  const exported = redactJson(policy, "export")(cleanRun)
  const exportedText = JSON.stringify(exported)
  const unrelated = unrelatedProtectedRecords(policy, { scenarios: [cleanRun] })
  const screenshot = classifyLocal("audit/step-1.png")
  const log = classifyLocal("audit/server.stderr.log")
  const notes = classifyLocal("notes.txt")
  const absent1 = contains(text, sentinelRecord)
  const absent2 = contains(text, targetRecord)
  const absent3 = contains(text, "issued-session-token")
  const absent4 = contains(exportedText, sentinelRecord)

  expect(absent1).toBe(false)
  expect(absent2).toBe(false)
  expect(absent3).toBe(false)
  expect(text).toContain("[redacted:secret]")
  expect(text).toContain("visible rows")
  expect(text).toContain("Password reset")
  expect(text).toContain("\"evidence\":\"protected-probe\"")
  expect(absent4).toBe(false)
  expect(unrelated).toEqual([sentinelRecord])
  expect(screenshot).toBe("screenshot")
  expect(log).toBe("server-log")
  expect(notes).toBe("unclassified")
})

const incomplete = EvidencePolicy.make({ ...policy, rules: Array.drop(localRules, 1) })

const policyTest = Effect.gen(function* () {
  const error = yield* pipe(incomplete, validatePolicy, Effect.flip)

  expect(error.message).toContain("run-report: 0 rules declared")
})

const sealTest = Effect.gen(function* () {
  const clean = yield* temporaryDirectory

  yield* ownedRun(clean, cleanRun, "listening\n")

  const sealed = yield* seal(clean, policy, secrets)
  const findings = sealFindings(sealed)

  expect(sealed.secrets).toBe(1)
  expect(sealed.protectedRecords).toBe(1)
  expect(findings).toEqual([])

  const leaky = yield* temporaryDirectory
  const visible = scenarioReport([{ id: sentinelRecord }])

  yield* ownedRun(leaky, visible, `login ${password}\n${sentinelRecord}\n`)

  const leaked = yield* seal(leaky, policy, secrets)

  expect(leaked.retained).toEqual(["audit/server.stdout.log"])
  expect(leaked.actorVisible).toEqual(["audit/scenario.json#actor-visible", "audit/server.stdout.log", "run.json#actor-visible"])
  expect(leaked.qa).toContain("qa:audit/scenario.json")
  expect(leaked.export).toContain("export:run.json")
})

const screenshotFile = Option.some("audit/step-1.png")

const escapingFile = Option.some("../outside.json")

const inspectionTest = Effect.gen(function* () {
  const directory = yield* temporaryDirectory

  yield* ownedRun(directory, cleanRun, "listening\n")

  const owner = yield* inspect(directory, "owner", scenarioFile)
  const qa = yield* inspect(directory, "qa", scenarioFile)
  const screenshot = yield* inspect(directory, "qa", screenshotFile)
  const listing = yield* inspect(directory, "qa", wholeDirectory)
  const exportInspection = inspect(directory, "export", wholeDirectory)
  const exportRefusal = yield* Effect.flip(exportInspection)
  const escapeInspection = inspect(directory, "owner", escapingFile)
  const escape = yield* Effect.flip(escapeInspection)
  const unowned = yield* temporaryDirectory

  yield* writeRun(unowned, cleanRun, "listening\n")

  const unownedInspection = inspect(unowned, "qa", wholeDirectory)
  const unownedRefusal = yield* Effect.flip(unownedInspection)
  const absent5 = contains(qa, sentinelRecord)
  const ownerSecret = contains(owner, "issued-session-token")

  expect(owner).toContain(sentinelRecord)
  expect(owner).toContain("[redacted:secret]")
  expect(ownerSecret).toBe(false)
  expect(absent5).toBe(false)
  expect(qa).toContain("Password reset")
  expect(screenshot).toContain("\"access\": \"digest\"")
  expect(listing).toContain("\"access\": \"digest\"")
  expect(listing).toContain("\"expires\": \"2026-01-31T00:00:00.000Z\"")
  expect(exportRefusal.message).toContain("export bundle")
  expect(escape.message).toContain("not a file inside")
  expect(unownedRefusal.message).toContain("No recorded evidence policy")
})

const exportTest = Effect.gen(function* () {
  const directory = yield* temporaryDirectory
  const marker = yield* ownedRun(directory, cleanRun, "listening\n")
  const sealed = yield* seal(directory, policy, secrets)

  yield* recordLineage(directory, marker, unsourcedFacts, sealed)

  const scratch = yield* temporaryDirectory
  const destination = join(scratch, "bundle")
  const bundledFiles = join(destination, "files")
  const manifest = yield* exportRun(directory, destination, [], apiKey)
  const exportedPaths = Array.map(manifest.files, Struct.get("path"))
  const bundled = yield* inspect(destination, "export", scenarioFile)
  const listedFiles = yield* Effect.tryPromise(() => readdir(bundledFiles, { recursive: true }))
  const repeated = exportRun(directory, destination, [], noKey)
  const again = yield* Effect.flip(repeated)
  const { policy: policyReference, secretScan } = manifest
  const absent6 = contains(bundled, sentinelRecord)
  const absent7 = Array.contains(listedFiles, "audit/step-1.png")

  expect(exportedPaths).toEqual([".acceptance-owner.json", "audit/scenario.json", "lineage.json", "run.json"])
  expect(manifest.excludedClasses).toEqual(["screenshot", "server-log"])
  expect(policyReference.revision).toBe("governance-test-evidence@1")
  expect(secretScan.findings).toEqual([])
  expect(secretScan.apiKeyChecked).toBe(true)
  expect(secretScan.sourcesMatchSeal).toBe(true)
  expect(absent6).toBe(false)
  expect(absent7).toBe(false)
  expect(again.message).toContain("never overwrite")

  const withScreenshots = join(scratch, "with-screenshots")
  const included = yield* exportRun(directory, withScreenshots, ["screenshot"], noKey)
  const includedClasses = Array.map(included.files, Struct.get("evidence"))

  expect(includedClasses).toContain("screenshot")

  const keyed = yield* temporaryDirectory
  const verifierPath = join(keyed, "verifier.json")
  const verifierJson = json({ note: `Bearer ${password}` })

  yield* ownedRun(keyed, cleanRun, "listening\n")
  yield* textFile(verifierPath, verifierJson)

  const refusedDestination = join(scratch, "refused")
  const refusedExport = exportRun(keyed, refusedDestination, [], apiKey)
  const refused = yield* Effect.flip(refusedExport)
  const refusedListing = yield* listDirectory(scratch)
  const absent8 = Array.contains(refusedListing, "refused")

  expect(refused.message).toContain("verifier.json: TYPESAFE_API_KEY")
  expect(absent8).toBe(false)
})

const byDirectory = (directory: string) => (run: PrunePlan["runs"][number]) => Equal.equals(run.directory, directory)

const byPath = (path: string) => (entry: PrunePlan["runs"][number]["entries"][number]) => Equal.equals(entry.path, path)

const describeEntry = (entry: PrunePlan["runs"][number]["entries"][number]) => `${entry.action} ${entry.path}`

const describeEntries = (run: PrunePlan["runs"][number]) => Array.map(run.entries, describeEntry)

const at = flow(DateTime.make<string>, Option.getOrThrow)

const actions = (plan: PrunePlan, directory: string) => pipe(
  plan.runs,
  Array.findFirst(byDirectory(directory)),
  Option.map(describeEntries),
  Option.getOrElse(Array.empty<string>),
)

const february = at("2026-02-01T00:00:00.000Z")

const july = at("2026-07-01T00:00:00.000Z")

const pruneTest = Effect.gen(function* () {
  const root = yield* temporaryDirectory
  const source = join(root, "source")
  const replay = join(root, "replay")
  const unsealed = join(root, "unsealed")
  const foreign = join(root, "foreign")
  const sourceAudit = join(source, "audit")
  const foreignAudit = join(foreign, "audit")
  const sourceReport = join(source, "run.json")
  const sourceMarker = yield* ownedRun(source, cleanRun, "listening\n")
  const sourceSeal = yield* seal(source, policy, secrets)

  yield* recordLineage(source, sourceMarker, unsourcedFacts, sourceSeal)

  const replayMarker = yield* ownedRun(replay, cleanRun, "listening\n")
  const replaySeal = yield* seal(replay, policy, secrets)
  const reference = yield* replaySource(replay, sourceReport)
  const replayFacts = pipe(reference, Option.some, lineageFacts)

  yield* recordLineage(replay, replayMarker, replayFacts, replaySeal)
  yield* ownedRun(unsealed, cleanRun, "listening\n")
  yield* writeRun(foreign, cleanRun, "listening\n")

  const dryRun = yield* prune(root, february, false)
  const untouched = yield* listDirectory(sourceAudit)
  const referencedRun = Option.getOrUndefined(reference.run)
  const sourceActions = actions(dryRun, "source")
  const unsealedActions = actions(dryRun, "unsealed")
  const absent9 = Array.contains(unsealedActions, "delete audit/step-1.png")

  expect(referencedRun).toBe(sourceMarker.run)
  expect(dryRun.unowned).toEqual(["foreign"])
  expect(sourceActions).toEqual(["keep .acceptance-owner.json", "keep audit/scenario.json", "delete audit/server.stdout.log", "delete audit/step-1.png", "keep lineage.json", "keep run.json"])
  expect(absent9).toBe(false)
  expect(untouched).toContain("step-1.png")

  const applied = yield* prune(root, february, true)
  const afterArtifacts = yield* listDirectory(sourceAudit)
  const foreignArtifacts = yield* listDirectory(foreignAudit)

  expect(applied.applied).toBe(true)
  expect(afterArtifacts).toEqual(["scenario.json"])
  expect(foreignArtifacts).toContain("step-1.png")

  const late = yield* prune(root, july, true)
  const remaining = yield* listDirectory(source)
  const sourcePlan = pipe(late.runs, Array.findFirst(byDirectory("source")), Option.getOrThrow)
  const runEntry = pipe(sourcePlan.entries, Array.findFirst(byPath("run.json")), Option.getOrThrow)
  const lineageFile = Option.some("lineage.json")
  const lineage = yield* inspect(source, "owner", lineageFile)
  const absent10 = Array.contains(remaining, "run.json")

  expect(sourcePlan.replaySourceOf).toEqual(["replay"])
  expect(runEntry.reason).toContain("replay source of replay: lineage.json retained")
  expect(remaining).toContain("lineage.json")
  expect(remaining).toContain(".acceptance-owner.json")
  expect(absent10).toBe(false)
  expect(lineage).toContain("\"prunedAt\": \"2026-07-01T00:00:00.000Z\"")
  expect(lineage).toContain("\"path\": \"audit/step-1.png\"")
})

it.effect("non-owner views digest protected records, keep permitted content, and always redact secret-keyed values", Function.constant(redactionTest))
it.effect("a policy must declare exactly one rule per evidence class", Function.constant(policyTest))
it.effect("the run-time seal finds credentials and unrelated protected records in retained, actor-visible, qa, and export bytes", Function.constant(sealTest))
it.effect("owner sees protected records with secrets masked, qa sees redacted reports and digests, and export consumers only read bundles", Function.constant(inspectionTest))
it.effect("exports redact JSON, exclude screenshots and logs by default, record a manifest, and refuse secrets or overwrites", Function.constant(exportTest))
it.effect("pruning touches only sealed owned runs, deletes expired artifacts on apply, and keeps lineage for replay sources", Function.constant(pruneTest))
