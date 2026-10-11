import { Array, DateTime, Effect, Equal, Function, Match, Option, Order, Predicate, Record, Redacted, Schema, String as Text, Struct, flow, pipe } from "effect"
import { randomUUID } from "node:crypto"
import type { Dirent, MakeDirectoryOptions, WriteFileOptions } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { amongst } from "./catalog.ts"
import { pretty, sha256 } from "./evidence.ts"
import { AcceptanceError, CatalogImport, ImportedCatalogSchema } from "./model.ts"

/** Every artifact a run retains belongs to exactly one class because access, redaction, export, and retention are decided per class. */
export const EvidenceClassSchema = Schema.Literals([
  "run-report",
  "scenario-report",
  "verifier-report",
  "fault-report",
  "calibration-report",
  "model-exchange",
  "observations",
  "protected-probe",
  "locator-repair",
  "screenshot",
  "server-log",
  "governance-record",
])

type EvidenceClass = typeof EvidenceClassSchema.Type

const ClassificationSchema = Schema.Union([EvidenceClassSchema, Schema.Literal("unclassified")])

type Classification = typeof ClassificationSchema.Type

export const ConsumerSchema = Schema.Literals(["owner", "qa", "export"])

type Consumer = typeof ConsumerSchema.Type

const QaAccessSchema = Schema.Literals(["full", "digest"])

const ExportHandlingSchema = Schema.Literals(["included", "digest", "excluded-by-default"])

const RetentionDaysSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const OptionalRetentionSchema = Schema.OptionFromOptionalKey(RetentionDaysSchema)

const FilePatternsSchema = Schema.Array(Schema.NonEmptyString)

/**
 * One class's handling. `files` are basenames or `*.ext` patterns; an empty list marks content embedded in report JSON
 * because model exchanges, observations, and protected probe payloads live inside scenario and run reports.
 * Absent `retentionDays` keeps a file class indefinitely and makes an embedded class follow its containing report.
 */
class ClassRule extends Schema.Class<ClassRule>("ClassRule")({
  evidence: EvidenceClassSchema,
  description: Schema.NonEmptyString,
  files: FilePatternsSchema,
  retentionDays: OptionalRetentionSchema,
  qa: QaAccessSchema,
  export: ExportHandlingSchema,
}) {}

/** A fixture probe whose results only a privileged fixture actor may read, because they can expose unrelated subjects' records. */
export class ProtectedProbe extends Schema.Class<ProtectedProbe>("ProtectedProbe")({
  probe: Schema.NonEmptyString,
  identity: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
}) {}

/** An operation whose results are privileged because a browser or direct call by an administrator returns protected records. */
export class ProtectedOperation extends Schema.Class<ProtectedOperation>("ProtectedOperation")({
  operation: Schema.NonEmptyString,
  identity: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
}) {}

const ProtectedProbesSchema = Schema.Array(ProtectedProbe)
const ProtectedOperationsSchema = Schema.Array(ProtectedOperation)
const ClassRulesSchema = Schema.Array(ClassRule)

const LocalScopeSchema = Schema.Literal("local-only")

/** The application's evidence policy because only the application knows which of its probes and operations return protected data. */
export class EvidencePolicy extends Schema.Class<EvidencePolicy>("EvidencePolicy")({
  application: Schema.NonEmptyString,
  revision: Schema.NonEmptyString,
  scope: LocalScopeSchema,
  protectedProbes: ProtectedProbesSchema,
  protectedOperations: ProtectedOperationsSchema,
  rules: ClassRulesSchema,
}) {}

const reportRetention = Option.some(180)

const artifactRetention = Option.some(30)

const indefinitely = Option.none<number>()

/** Conservative local-only handling because no remote consumer or production-data policy exists yet. */
export const localRules: ReadonlyArray<ClassRule> = [
  ClassRule.make({ evidence: "run-report", description: "run.json: catalog, build identity, configuration, every scenario run, coverage, and verdicts", files: ["run.json"], retentionDays: reportRetention, qa: "full", export: "included" }),
  ClassRule.make({ evidence: "scenario-report", description: "scenario.json: one scenario's fixture, candidates, submissions, trace, probes, and results", files: ["scenario.json"], retentionDays: reportRetention, qa: "full", export: "included" }),
  ClassRule.make({ evidence: "verifier-report", description: "verifier.json: synthetic defective-evaluator controls", files: ["verifier.json"], retentionDays: reportRetention, qa: "full", export: "included" }),
  ClassRule.make({ evidence: "fault-report", description: "faults.json: injected-fault and clean-control outcomes", files: ["faults.json"], retentionDays: reportRetention, qa: "full", export: "included" }),
  ClassRule.make({ evidence: "calibration-report", description: "calibration.json: held-out decision trials", files: ["calibration.json"], retentionDays: reportRetention, qa: "full", export: "included" }),
  ClassRule.make({ evidence: "model-exchange", description: "Decision model requests and responses embedded in traces; the API key is only ever in a header", files: [], retentionDays: indefinitely, qa: "full", export: "included" }),
  ClassRule.make({ evidence: "observations", description: "Rows the scenario actor saw in the browser, embedded in reports", files: [], retentionDays: indefinitely, qa: "full", export: "included" }),
  ClassRule.make({ evidence: "protected-probe", description: "Results of policy-declared protected probes and operations, embedded in reports", files: [], retentionDays: indefinitely, qa: "digest", export: "digest" }),
  ClassRule.make({ evidence: "locator-repair", description: "Locator repair provenance on repaired replay steps: original and repaired locators, the failure, live checks, and matched semantics", files: [], retentionDays: indefinitely, qa: "full", export: "included" }),
  ClassRule.make({ evidence: "screenshot", description: "Browser screenshots; pixels cannot be redacted structurally", files: ["*.png"], retentionDays: artifactRetention, qa: "digest", export: "excluded-by-default" }),
  ClassRule.make({ evidence: "server-log", description: "Isolated application stdout/stderr; lines cannot be redacted structurally", files: ["*.log"], retentionDays: artifactRetention, qa: "digest", export: "excluded-by-default" }),
  ClassRule.make({ evidence: "governance-record", description: "Ownership marker and lineage manifest kept after artifacts are pruned", files: [".acceptance-owner.json", "lineage.json"], retentionDays: indefinitely, qa: "full", export: "included" }),
]

export const ownershipFile = ".acceptance-owner.json"

export const lineageFile = "lineage.json"

const manifestFile = "manifest.json"

const exportFormat = "effect-domains-acceptance-export@1"

const RunKindSchema = Schema.Literals(["exploration", "replay", "repaired-replay", "faults"])

const OwnershipFormatSchema = Schema.Literal("effect-domains-acceptance-ownership@1")

const LineageFormatSchema = Schema.Literal("effect-domains-acceptance-lineage@1")

const ExportFormatSchema = Schema.Literal(exportFormat)

const DigestAccessSchema = Schema.Literal("digest")

const OptionalTextSchema = Schema.OptionFromOptionalKey(Schema.String)

/** Written at run start because only directories a run created and claimed may ever be deleted. */
class OwnershipMarker extends Schema.Class<OwnershipMarker>("OwnershipMarker")({
  format: OwnershipFormatSchema,
  run: Schema.NonEmptyString,
  application: Schema.NonEmptyString,
  kind: RunKindSchema,
  startedAt: Schema.String,
  policy: EvidencePolicy,
}) {}

const PathsSchema = Schema.Array(Schema.String)

/** What the run-time seal found because the run's secrets exist only in memory while the run is alive. */
export class Seal extends Schema.Class<Seal>("Seal")({
  secrets: Schema.Int,
  protectedRecords: Schema.Int,
  retained: PathsSchema,
  actorVisible: PathsSchema,
  qa: PathsSchema,
  export: PathsSchema,
}) {}

class Artifact extends Schema.Class<Artifact>("Artifact")({
  path: Schema.String,
  evidence: ClassificationSchema,
  sha256: Schema.String,
  bytes: Schema.Int,
}) {}

class PrunedArtifact extends Schema.Class<PrunedArtifact>("PrunedArtifact")({
  path: Schema.String,
  evidence: ClassificationSchema,
  sha256: Schema.String,
  prunedAt: Schema.String,
}) {}

const ImportedCatalogsSchema = Schema.Array(ImportedCatalogSchema)

export class LineageBuild extends Schema.Class<LineageBuild>("LineageBuild")({
  sha256: Schema.String,
  catalogHash: Schema.String,
  nativeContractsHash: Schema.String,
  importedCatalogs: ImportedCatalogsSchema,
}) {}

export class LineageResult extends Schema.Class<LineageResult>("LineageResult")({
  scope: Schema.String,
  requirement: Schema.String,
  status: Schema.String,
}) {}

/** The replay source is recorded relative to the replay's directory, with the source run id and hash, because copies must keep resolving. */
export class ReplaySource extends Schema.Class<ReplaySource>("ReplaySource")({
  path: Schema.String,
  run: OptionalTextSchema,
  sha256: Schema.String,
}) {}

/** A repaired replay's lineage names its preserved strict attempt, how many steps were repaired, and the presentation-only files accepted, because a repair must stay attributable after artifacts are pruned. */
export class LineageRepair extends Schema.Class<LineageRepair>("LineageRepair")({
  strictAttempt: Schema.String,
  strictStatus: Schema.String,
  repaired: Schema.Int,
  presentation: PathsSchema,
}) {}

const ImportsSchema = Schema.Array(CatalogImport)
const LineageResultsSchema = Schema.Array(LineageResult)
const OptionalReplaySourceSchema = Schema.OptionFromOptionalKey(ReplaySource)
const OptionalRepairSchema = Schema.OptionFromOptionalKey(LineageRepair)

/** The facts a run contributes to its lineage because only the runner knows its build, catalog, results, replay source, and repairs. */
export class LineageFacts extends Schema.Class<LineageFacts>("LineageFacts")({
  finishedAt: Schema.String,
  status: Schema.String,
  build: LineageBuild,
  catalog: Schema.String,
  catalogRevision: Schema.String,
  imports: ImportsSchema,
  results: LineageResultsSchema,
  replaySource: OptionalReplaySourceSchema,
  repair: OptionalRepairSchema,
}) {}

const ArtifactsSchema = Schema.Array(Artifact)
const PrunedArtifactsSchema = Schema.Array(PrunedArtifact)

/** Kept after every artifact is pruned because build, catalog, results, and replay lineage must outlive the evidence itself. */
class Lineage extends Schema.Class<Lineage>("Lineage")({
  format: LineageFormatSchema,
  run: Schema.NonEmptyString,
  application: Schema.NonEmptyString,
  kind: RunKindSchema,
  policyRevision: Schema.String,
  startedAt: Schema.String,
  facts: LineageFacts,
  artifacts: ArtifactsSchema,
  seal: Seal,
  pruned: PrunedArtifactsSchema,
}) {}

class ExportedFile extends Schema.Class<ExportedFile>("ExportedFile")({
  path: Schema.String,
  evidence: ClassificationSchema,
  sha256: Schema.String,
  sourceSha256: Schema.String,
  bytes: Schema.Int,
}) {}

class ExcludedFile extends Schema.Class<ExcludedFile>("ExcludedFile")({
  path: Schema.String,
  evidence: ClassificationSchema,
  sha256: Schema.String,
  reason: Schema.String,
}) {}

class PolicyReference extends Schema.Class<PolicyReference>("PolicyReference")({
  application: Schema.String,
  revision: Schema.String,
}) {}

const DetectorsSchema = Schema.Array(Schema.String)
const OptionalSealSchema = Schema.OptionFromOptionalKey(Seal)

class SecretScan extends Schema.Class<SecretScan>("SecretScan")({
  detectors: DetectorsSchema,
  apiKeyChecked: Schema.Boolean,
  findings: PathsSchema,
  runSeal: OptionalSealSchema,
  sourcesMatchSeal: Schema.Boolean,
}) {}

const ExportedFilesSchema = Schema.Array(ExportedFile)
const ExcludedFilesSchema = Schema.Array(ExcludedFile)
const ExcludedClassesSchema = Schema.Array(ClassificationSchema)

export class ExportManifest extends Schema.Class<ExportManifest>("ExportManifest")({
  format: ExportFormatSchema,
  application: Schema.String,
  source: Schema.String,
  run: Schema.String,
  policy: PolicyReference,
  exportedAt: Schema.String,
  files: ExportedFilesSchema,
  excluded: ExcludedFilesSchema,
  excludedClasses: ExcludedClassesSchema,
  secretScan: SecretScan,
}) {}

const AccessSchema = Schema.Literals(["raw", "full", "digest", "excluded"])

type Access = typeof AccessSchema.Type

class ListedArtifact extends Schema.Class<ListedArtifact>("ListedArtifact")({
  path: Schema.String,
  evidence: ClassificationSchema,
  bytes: Schema.Int,
  sha256: Schema.String,
  access: AccessSchema,
  expires: OptionalTextSchema,
}) {}

const ListedArtifactsSchema = Schema.Array(ListedArtifact)
const OptionalPolicySchema = Schema.OptionFromOptionalKey(PolicyReference)

class Inventory extends Schema.Class<Inventory>("Inventory")({
  consumer: ConsumerSchema,
  policy: OptionalPolicySchema,
  run: OptionalTextSchema,
  seal: OptionalSealSchema,
  artifacts: ListedArtifactsSchema,
}) {}

class DigestView extends Schema.Class<DigestView>("DigestView")({
  path: Schema.String,
  evidence: ClassificationSchema,
  sha256: Schema.String,
  bytes: Schema.Int,
  access: DigestAccessSchema,
}) {}

const PruneActionSchema = Schema.Literals(["delete", "keep"])

class PruneEntry extends Schema.Class<PruneEntry>("PruneEntry")({
  path: Schema.String,
  evidence: ClassificationSchema,
  action: PruneActionSchema,
  reason: Schema.String,
}) {}

const PruneEntriesSchema = Schema.Array(PruneEntry)
const RunStatusSchema = Schema.Literals(["sealed", "unsealed"])

class PrunedRun extends Schema.Class<PrunedRun>("PrunedRun")({
  directory: Schema.String,
  run: Schema.String,
  status: RunStatusSchema,
  replaySourceOf: PathsSchema,
  entries: PruneEntriesSchema,
}) {}

const PrunedRunsSchema = Schema.Array(PrunedRun)

export class PrunePlan extends Schema.Class<PrunePlan>("PrunePlan")({
  root: Schema.String,
  now: Schema.String,
  applied: Schema.Boolean,
  runs: PrunedRunsSchema,
  unowned: PathsSchema,
}) {}

const DigestSchema = Schema.Struct({ redacted: Schema.Literal("protected"), evidence: EvidenceClassSchema, sha256: Schema.String })

interface Digest extends Schema.Schema.Type<typeof DigestSchema> {}

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)

type JsonRecord = typeof JsonRecordSchema.Type

const ProbeRecordSchema = Schema.Struct({ probe: Schema.String, phase: Schema.String, subject: Schema.String })

interface ProbeRecord extends Schema.Schema.Type<typeof ProbeRecordSchema> {}

const SubmissionRecordSchema = Schema.Struct({ inputCase: Schema.String, operation: Schema.String, status: Schema.Number })

interface SubmissionRecord extends Schema.Schema.Type<typeof SubmissionRecordSchema> {}

const UnknownsSchema = Schema.Array(Schema.Unknown)

const ObservationRecordSchema = Schema.Struct({ operation: Schema.String, resource: Schema.String, loaded: Schema.Boolean, rows: UnknownsSchema })

interface ObservationRecord extends Schema.Schema.Type<typeof ObservationRecordSchema> {}

const DecisionRecordSchema = Schema.Struct({ choice: Schema.String, confidence: Schema.Number, request: Schema.Unknown, response: Schema.Unknown })

interface DecisionRecord extends Schema.Schema.Type<typeof DecisionRecordSchema> {}

const RepairRecordSchema = Schema.Struct({ originalTarget: Schema.String, repairedTarget: Schema.String, failure: Schema.String, checks: UnknownsSchema })

interface RepairRecord extends Schema.Schema.Type<typeof RepairRecordSchema> {}

const FixtureFactsSchema = Schema.Struct({ facts: JsonRecordSchema })

interface FixtureFacts extends Schema.Schema.Type<typeof FixtureFactsSchema> {}

const ScenarioRunRecordSchema = Schema.Struct({
  fixture: FixtureFactsSchema,
  probes: UnknownsSchema,
  submissions: UnknownsSchema,
  candidates: UnknownsSchema,
  before: UnknownsSchema,
  after: UnknownsSchema,
  trace: UnknownsSchema,
})

interface ScenarioRunRecord extends Schema.Schema.Type<typeof ScenarioRunRecordSchema> {}

const isJsonRecord = Schema.is(JsonRecordSchema)
const isProbeRecord: (value: unknown) => value is ProbeRecord = Schema.is(ProbeRecordSchema)
const isSubmissionRecord: (value: unknown) => value is SubmissionRecord = Schema.is(SubmissionRecordSchema)
const isObservationRecord: (value: unknown) => value is ObservationRecord = Schema.is(ObservationRecordSchema)
const isDecisionRecord: (value: unknown) => value is DecisionRecord = Schema.is(DecisionRecordSchema)
const isRepairRecord: (value: unknown) => value is RepairRecord = Schema.is(RepairRecordSchema)
const isScenarioRunRecord: (value: unknown) => value is ScenarioRunRecord = Schema.is(ScenarioRunRecordSchema)

const directoryOptions: MakeDirectoryOptions = { recursive: true, mode: 0o700 }

const fileOptions: WriteFileOptions = { mode: 0o600 }

const listingOptions = { withFileTypes: true, recursive: true } as const

const governanceError = (message: string) => AcceptanceError.make({ boundary: "governance", message })

const describeFailure = flow(String, governanceError)

const jsonText = (value: unknown) => `${JSON.stringify(value)}`

const utf8 = (content: Uint8Array) => Buffer.from(content).toString("utf8")

const secretKeys = ["password", "token", "secret", "authorization", "apikey", "api_key", "cookie", "sessiontoken", "accesstoken"]

const secretMarker = "[redacted:secret]"

const isSecretKey = flow(Text.toLowerCase, amongst(secretKeys))

const reportClasses: ReadonlyArray<Classification> = ["run-report", "scenario-report", "verifier-report", "fault-report", "calibration-report", "governance-record"]

const isReport = (evidence: Classification) => Array.contains(reportClasses, evidence)

const matchesPattern = (name: string) => (pattern: string) => {
  const suffix = Text.startsWith("*")(pattern) ? pipe(pattern, Text.slice(1), Option.some) : Option.none<string>()

  return Option.match(suffix, { onNone: () => Equal.equals(name, pattern), onSome: (ending) => Text.endsWith(ending)(name) })
}

const claims = (name: string) => (rule: ClassRule) => Array.some(rule.files, matchesPattern(name))

const firstClaiming = (rules: ReadonlyArray<ClassRule>) => (claim: (rule: ClassRule) => boolean) => Array.findFirst(rules, claim)

const unclassified = Function.constant<Classification>("unclassified")

/** Classifies a retained file by its basename because the runner names every artifact it writes. */
export const classify = (rules: ReadonlyArray<ClassRule>) => (path: string): Classification =>
  pipe(path, basename, claims, firstClaiming(rules), Option.map(Struct.get("evidence")), Option.getOrElse(unclassified))

const byEvidence = (evidence: Classification) => (rule: ClassRule) => Equal.equals(rule.evidence, evidence)

const ruleFor = (policy: EvidencePolicy) => (evidence: Classification) => Array.findFirst(policy.rules, byEvidence(evidence))

const exportAccess = (rule: ClassRule): Access => {
  const included = Equal.equals(rule.export, "included")
  const digested = Equal.equals(rule.export, "digest")
  const restricted: Access = digested ? "digest" : "excluded"

  return included ? "full" : restricted
}

const ruleAccess = (consumer: Consumer) => (rule: ClassRule): Access => Equal.equals(consumer, "qa") ? rule.qa : exportAccess(rule)

/** The access a consumer has to a class because owner access is raw and every other consumer follows the declared rule. */
export const accessFor = (policy: EvidencePolicy, consumer: Consumer, evidence: Classification): Access => {
  const owner = Equal.equals(consumer, "owner")
  const declared = pipe(evidence, ruleFor(policy), Option.map(ruleAccess(consumer)), Option.getOrElse(Function.constant<Access>("excluded")))

  return owner ? "raw" : declared
}

const policyProblems = (policy: EvidencePolicy) => (evidence: EvidenceClass) => {
  const declared = Array.filter(policy.rules, byEvidence(evidence))
  const embedded = Array.some(declared, flow(Struct.get("files"), Array.isReadonlyArrayEmpty))
  const excludedEmbedded = Array.some(declared, isExcludedEmbedded)
  const once = Equal.equals(declared.length, 1)
  const reportable = once ? Option.none<string>() : Option.some(`${evidence}: ${declared.length} rules declared, exactly one required`)
  const embeddable = excludedEmbedded ? Option.some(`${evidence}: embedded content can be digested but not excluded`) : Option.none<string>()

  return embedded ? Array.getSomes([reportable, embeddable]) : Array.getSomes([reportable])
}

const isExcludedEmbedded = (rule: ClassRule) => {
  const embedded = Array.isReadonlyArrayEmpty(rule.files)

  return embedded && Equal.equals(rule.export, "excluded-by-default")
}

/** Rejects a policy without exactly one rule per evidence class because an unclassified artifact would have no declared handling. */
export const validatePolicy = Effect.fn("Acceptance.governance.validatePolicy")(function* (policy: EvidencePolicy) {
  const problems = Array.flatMap(EvidenceClassSchema.literals, policyProblems(policy))
  const joined = Array.join(problems, "; ")

  if (Array.isReadonlyArrayNonEmpty(problems)) return yield* governanceError(`Invalid evidence policy ${policy.revision}: ${joined}`)

  return policy
})

const digestOf = (evidence: EvidenceClass) => (value: unknown): Digest => DigestSchema.make({ redacted: "protected", evidence, sha256: pipe(value, jsonText, sha256) })

const protectedProbeNames = (policy: EvidencePolicy) => Array.map(policy.protectedProbes, Struct.get("probe"))

const protectedOperationNames = (policy: EvidencePolicy) => Array.map(policy.protectedOperations, Struct.get("operation"))

const byProtectedProbe = (policy: EvidencePolicy) => (value: JsonRecord): boolean => {
  const names = protectedProbeNames(policy)

  return isProbeRecord(value) && Array.contains(names, value.probe)
}

const byProtectedSubmission = (policy: EvidencePolicy) => (value: JsonRecord): boolean => {
  const names = protectedOperationNames(policy)

  return isSubmissionRecord(value) && Array.contains(names, value.operation)
}

const byProtectedRecord = (policy: EvidencePolicy) => (value: JsonRecord): boolean => byProtectedProbe(policy)(value) || byProtectedSubmission(policy)(value)

/** Where an embedded class lives inside report JSON and which of its fields carry the content. */
class EmbeddedLocation extends Schema.Class<EmbeddedLocation>("EmbeddedLocation")({
  evidence: EvidenceClassSchema,
  fields: PathsSchema,
}) {}

const protectedLocation = EmbeddedLocation.make({ evidence: "protected-probe", fields: ["result", "error"] })

const observationLocation = EmbeddedLocation.make({ evidence: "observations", fields: ["rows"] })

const exchangeLocation = EmbeddedLocation.make({ evidence: "model-exchange", fields: ["request", "response"] })

const repairLocation = EmbeddedLocation.make({ evidence: "locator-repair", fields: ["failure", "checks"] })

const protectedFound = Option.some(protectedLocation)

const observationFound = Option.some(observationLocation)

const repairFound = Option.some(repairLocation)

const exchangeFound = Option.some(exchangeLocation)

const notEmbedded = Option.none<EmbeddedLocation>()

// Embedded classes are matched in precedence order because a protected record must be classified before any broader record shape.
const embeddedLocation = (policy: EvidencePolicy, value: JsonRecord) => pipe(
  Match.value(value),
  Match.when(byProtectedRecord(policy), Function.constant(protectedFound)),
  Match.when(isObservationRecord, Function.constant(observationFound)),
  Match.when(isRepairRecord, Function.constant(repairFound)),
  Match.when(isDecisionRecord, Function.constant(exchangeFound)),
  Match.orElse(Function.constant(notEmbedded)),
)

const consumerAccess = (policy: EvidencePolicy, consumer: Consumer) => (evidence: Classification) => accessFor(policy, consumer, evidence)

const digestedLocation = (policy: EvidencePolicy, consumer: Consumer) => flow(Struct.get<EmbeddedLocation, "evidence">("evidence"), consumerAccess(policy, consumer), Equal.equals<Access>("digest"))

type Redactor = (value: unknown) => unknown

const redactEntry = (redactor: Redactor, digested: Option.Option<EmbeddedLocation>) => (value: unknown, key: string) => {
  const secretValue = isSecretKey(key) && Predicate.isString(value)
  const located = Option.filter(digested, flow(Struct.get("fields"), Array.contains(key)))

  if (secretValue) return secretMarker

  return Option.match(located, { onNone: () => redactor(value), onSome: (location) => digestOf(location.evidence)(value) })
}

/** Redacts parsed report JSON for a non-owner consumer: secret-keyed strings always, embedded classes the policy digests for that consumer. */
export const redactJson = (policy: EvidencePolicy, consumer: Consumer): Redactor => {
  const redactor: Redactor = (value) => {
    if (Array.isArray(value)) return Array.map(value, redactor)

    if (!isJsonRecord(value)) return value

    const digested = pipe(embeddedLocation(policy, value), Option.filter(digestedLocation(policy, consumer)))

    return Record.map(value, redactEntry(redactor, digested))
  }

  return redactor
}

const childValues = (value: unknown): ReadonlyArray<unknown> => {
  if (Array.isArray(value)) return value

  return isJsonRecord(value) ? Record.values(value) : Array.empty()
}

const nestedScenarioRuns = (value: unknown): ReadonlyArray<ScenarioRunRecord> => {
  const own = isScenarioRunRecord(value) ? Array.of(value) : Array.empty<ScenarioRunRecord>()
  const nested = pipe(value, childValues, Array.flatMap(nestedScenarioRuns))

  return Array.appendAll(own, nested)
}

const fieldOf = (field: string) => (record: unknown): Option.Option<unknown> => isJsonRecord(record) ? Record.get(record, field) : Option.none()

const identityOf = (field: string) => flow(fieldOf(field), Option.filter(Predicate.isString))

const capturedId = (submission: unknown) => {
  const accepted = isSubmissionRecord(submission) && Order.isBetween(Order.Number)({ minimum: 200, maximum: 299 })(submission.status)
  const identified = pipe(submission, fieldOf("result"), Option.flatMap(identityOf("id")))

  return accepted ? identified : Option.none<string>()
}

const relatedSubjects = (run: ScenarioRunRecord) => {
  const target = pipe(run.fixture.facts, Record.get("target.id"), Option.filter(Predicate.isString), Option.toArray)
  const captured = pipe(run.submissions, Array.map(capturedId), Array.getSomes)

  return Array.appendAll(target, captured)
}

const asRecords = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : Array.of(value)

const recordIdentities = (field: string) => flow(asRecords, Array.map(identityOf(field)), Array.getSomes)

const byProbe = (name: string) => (probe: ProtectedProbe) => Equal.equals(probe.probe, name)

const declarationFor = (policy: EvidencePolicy) => (record: ProbeRecord) => Array.findFirst(policy.protectedProbes, byProbe(record.probe))

const declaredIdentities = (result: Option.Option<unknown>) => (declared: ProtectedProbe) => Option.match(result, { onNone: Array.empty<string>, onSome: recordIdentities(declared.identity) })

const unrelatedIdentities = (policy: EvidencePolicy, related: ReadonlyArray<string>) => (probe: unknown) => {
  const probeRecord = Option.liftPredicate(probe, isProbeRecord)
  const unrelated = Option.filter(probeRecord, flow(Struct.get("subject"), Predicate.not(amongst(related))))
  const declaration = Option.flatMap(unrelated, declarationFor(policy))
  const result = fieldOf("result")(probe)
  const identities = Option.map(declaration, declaredIdentities(result))

  return Option.getOrElse(identities, Array.empty<string>)
}

const scenarioIdentities = (policy: EvidencePolicy) => (scenario: ScenarioRunRecord) => {
  const related = relatedSubjects(scenario)

  return Array.flatMap(scenario.probes, unrelatedIdentities(policy, related))
}

/** Identities of protected records about subjects the scenario never touched because those must not reach any non-owner view. */
export const unrelatedProtectedRecords = (policy: EvidencePolicy, report: unknown) => pipe(report, nestedScenarioRuns, Array.flatMap(scenarioIdentities(policy)), Array.dedupe)

/** What the scenario actor could see because candidates, observations, and the trace (including model exchanges) mirror the actor's own browser. */
const actorVisibleText = (run: ScenarioRunRecord) => jsonText([run.candidates, run.before, run.after, run.trace])

const recursiveEntries = (path: string) => Effect.tryPromise({ try: () => readdir(path, listingOptions), catch: describeFailure })

const entryPath = (root: string) => (entry: Dirent) => {
  const absolute = join(entry.parentPath, entry.name)

  return relative(root, absolute)
}

const isFileEntry = (entry: Dirent) => entry.isFile()

const listFiles = Effect.fn("Acceptance.governance.listFiles")(function* (root: string) {
  const entries = yield* recursiveEntries(root)
  const files = pipe(entries, Array.filter(isFileEntry), Array.map(entryPath(root)))

  return Array.sort(files, Order.String)
})

const readBytes = (path: string) => Effect.tryPromise({ try: () => readFile(path), catch: describeFailure })

const fileExists = (path: string) => Effect.tryPromise({ try: () => Bun.file(path).exists(), catch: describeFailure })

const parseJson = (content: Uint8Array) => {
  const text = utf8(content)

  return Effect.try({ try: (): unknown => JSON.parse(text), catch: describeFailure })
}

const decodeFile = <A, I>(schema: Schema.Codec<A, I>) => Effect.fn("Acceptance.governance.decodeFile")(function* (path: string) {
  const content = yield* readBytes(path)
  const parsed = yield* parseJson(content)

  return yield* pipe(parsed, Schema.decodeUnknownEffect(schema), Effect.mapError(describeFailure))
})

const optionalFile = <A, I>(schema: Schema.Codec<A, I>) => Effect.fn("Acceptance.governance.optionalFile")(function* (path: string) {
  const present = yield* fileExists(path)

  return present ? yield* pipe(path, decodeFile(schema), Effect.asSome) : Option.none<A>()
})

const writeAtomically = Effect.fn("Acceptance.governance.write")(function* (path: string, content: string | Uint8Array) {
  const staged = `${path}.pending`
  const parent = dirname(path)

  yield* Effect.tryPromise({ try: () => mkdir(parent, directoryOptions), catch: describeFailure })
  yield* Effect.tryPromise({ try: () => writeFile(staged, content, fileOptions), catch: describeFailure })
  yield* Effect.tryPromise({ try: () => rename(staged, path), catch: describeFailure })
})

const encodedFile = <A, I>(schema: Schema.Codec<A, I>) => Effect.fn("Acceptance.governance.encodedFile")(function* (path: string, value: A) {
  const encoded = yield* pipe(value, Schema.encodeEffect(schema), Effect.mapError(describeFailure))
  const text = pretty(encoded)

  yield* writeAtomically(path, text)
})

class LoadedFile extends Schema.Class<LoadedFile>("LoadedFile")({
  path: Schema.String,
  evidence: ClassificationSchema,
  content: Schema.Uint8Array,
}) {}

const loadFile = (root: string, rules: ReadonlyArray<ClassRule>) => Effect.fn("Acceptance.governance.loadFile")(function* (path: string) {
  const absolute = join(root, path)
  const content = yield* readBytes(absolute)

  return LoadedFile.make({ path, evidence: classify(rules)(path), content })
})

const isLineageCandidate = (path: string) => !Equal.equals(path, lineageFile)

const loadRun = Effect.fn("Acceptance.governance.loadRun")(function* (root: string, rules: ReadonlyArray<ClassRule>) {
  const paths = yield* listFiles(root)
  const files = Array.filter(paths, isLineageCandidate)

  return yield* Effect.forEach(files, loadFile(root, rules))
})

const artifactOf = (file: LoadedFile) => Artifact.make({ path: file.path, evidence: file.evidence, sha256: sha256(file.content), bytes: file.content.length })

const viewBytes = (policy: EvidencePolicy, consumer: Consumer) => Effect.fn("Acceptance.governance.viewBytes")(function* (file: LoadedFile) {
  const parsed = yield* parseJson(file.content)

  return pipe(parsed, redactJson(policy, consumer), pretty, Buffer.from)
})

const digestRecord = (file: LoadedFile) => DigestView.make({ path: file.path, evidence: file.evidence, sha256: sha256(file.content), bytes: file.content.length, access: "digest" })

const digestView = flow(digestRecord, pretty, Buffer.from)

/** The bytes a qa consumer receives because qa sees report content redacted and other classes only as digests. */
const qaView = (policy: EvidencePolicy) => (file: LoadedFile) => {
  const access = accessFor(policy, "qa", file.evidence)
  const full = Equal.equals(access, "full")
  const readable = full && isReport(file.evidence)
  const bytes = full ? Buffer.from(file.content) : digestView(file)

  return readable ? viewBytes(policy, "qa")(file) : Effect.succeed(bytes)
}

class BundleFile extends Schema.Class<BundleFile>("BundleFile")({
  path: Schema.String,
  evidence: ClassificationSchema,
  content: Schema.Uint8Array,
  sourceSha256: Schema.String,
}) {}

const BundleFilesSchema = Schema.Array(BundleFile)

class Bundle extends Schema.Class<Bundle>("Bundle")({
  files: BundleFilesSchema,
  excluded: ExcludedFilesSchema,
}) {}

const exportReason = (rule: Option.Option<ClassRule>) => Option.match(rule, {
  onNone: Function.constant("unclassified artifacts are never exported"),
  onSome: (declared) => Equal.equals(declared.export, "digest") ? "digest-only class" : "excluded by default; pass --include to export",
})

const excludedFor = (policy: EvidencePolicy) => (file: LoadedFile) => {
  const rule = ruleFor(policy)(file.evidence)
  const reason = exportReason(rule)

  return ExcludedFile.make({ path: file.path, evidence: file.evidence, sha256: sha256(file.content), reason })
}

const bundleEntry = (policy: EvidencePolicy, include: ReadonlyArray<EvidenceClass>) => Effect.fn("Acceptance.governance.bundleEntry")(function* (file: LoadedFile) {
  const handling = pipe(file.evidence, ruleFor(policy), Option.map(Struct.get("export")))
  const included = Option.contains(handling, "included")
  const optedIn = Option.contains(handling, "excluded-by-default") && Array.contains(include, file.evidence)
  const json = included && isReport(file.evidence)
  const exported = included || optedIn
  const sourceSha256 = sha256(file.content)

  if (json) {
    const content = yield* viewBytes(policy, "export")(file)
    const viewed = BundleFile.make({ path: file.path, evidence: file.evidence, content, sourceSha256 })

    return Option.some(viewed)
  }

  const copied = BundleFile.make({ path: file.path, evidence: file.evidence, content: file.content, sourceSha256 })

  return exported ? Option.some(copied) : Option.none<BundleFile>()
})

const bundleOf = Effect.fn("Acceptance.governance.bundle")(function* (policy: EvidencePolicy, files: ReadonlyArray<LoadedFile>, include: ReadonlyArray<EvidenceClass>) {
  const entries = yield* Effect.forEach(files, bundleEntry(policy, include))
  const exported = Array.getSomes(entries)
  const paths = Array.map(exported, Struct.get("path"))
  const left = Array.filter(files, flow(Struct.get("path"), Predicate.not(amongst(paths))))
  const excluded = Array.map(left, excludedFor(policy))

  return Bundle.make({ files: exported, excluded })
})

const includedIn = (haystack: Buffer) => (needle: Buffer): boolean => haystack.includes(needle)

const byNeedles = (needles: ReadonlyArray<Buffer>) => (content: Uint8Array): boolean => {
  const haystack = Buffer.from(content)

  return Array.some(needles, includedIn(haystack))
}

const nonEmpty = flow(Redacted.value<string>, Text.isNonEmpty)

const secretNeedles = (secrets: ReadonlyArray<Redacted.Redacted<string>>) => pipe(secrets, Array.filter(nonEmpty), Array.map(flow(Redacted.value<string>, Buffer.from)))

const leaking = (needles: ReadonlyArray<Buffer>, prefix: string) => (path: string, content: Uint8Array) => byNeedles(needles)(content) ? Option.some(`${prefix}${path}`) : Option.none<string>()

const scenarioLeaks = (needles: ReadonlyArray<Buffer>, path: string) => (report: unknown) => {
  const visible = pipe(report, nestedScenarioRuns, Array.map(actorVisibleText), Array.map(Buffer.from))
  const leaked = Array.some(visible, byNeedles(needles))

  return leaked ? Array.of(`${path}#actor-visible`) : Array.empty<string>()
}

const parsedReport = (file: LoadedFile) => isReport(file.evidence) ? pipe(file.content, parseJson, Effect.asSome) : Effect.succeedNone

const actorVisibleLeaks = (needles: ReadonlyArray<Buffer>) => Effect.fn("Acceptance.governance.actorVisible")(function* (file: LoadedFile) {
  const report = yield* parsedReport(file)
  const binary = Array.contains(["screenshot", "server-log"], file.evidence)
  const leak = leaking(needles, "")(file.path, file.content)
  const direct = binary ? Option.toArray(leak) : Array.empty<string>()
  const embedded = Option.match(report, { onNone: Array.empty<string>, onSome: scenarioLeaks(needles, file.path) })

  return Array.appendAll(direct, embedded)
})

const qaLeak = (policy: EvidencePolicy, needles: ReadonlyArray<Buffer>) => Effect.fn("Acceptance.governance.qaLeak")(function* (file: LoadedFile) {
  const view = yield* qaView(policy)(file)

  return leaking(needles, "qa:")(file.path, view)
})

const bundleLeak = (needles: ReadonlyArray<Buffer>) => (file: BundleFile) => leaking(needles, "export:")(file.path, file.content)

const retainedLeak = (needles: ReadonlyArray<Buffer>) => (file: LoadedFile) => leaking(needles, "")(file.path, file.content)

const reportIdentities = (policy: EvidencePolicy) => Effect.fn("Acceptance.governance.reportIdentities")(function* (file: LoadedFile) {
  const report = yield* parsedReport(file)

  return Option.match(report, { onNone: Array.empty<string>, onSome: (value) => unrelatedProtectedRecords(policy, value) })
})

/**
 * Seals a finished run while its secrets are still in memory: retained bytes are scanned for every secret, actor-visible
 * evidence (screenshots, logs, observations, traces) for unrelated protected records, and the derived qa view and default
 * export bundle for both, because a later inspection or export can no longer obtain the run's generated credentials.
 */
export const seal = Effect.fn("Acceptance.governance.seal")(function* (output: string, policy: EvidencePolicy, secrets: ReadonlyArray<Redacted.Redacted<string>>) {
  const files = yield* loadRun(output, policy.rules)
  const credentials = secretNeedles(secrets)
  const identities = yield* Effect.forEach(files, reportIdentities(policy))
  const records = pipe(identities, Array.flatten, Array.dedupe)
  const recordNeedles = Array.map(records, Buffer.from)
  const everything = Array.appendAll(credentials, recordNeedles)
  const retained = pipe(files, Array.map(retainedLeak(credentials)), Array.getSomes)
  const visible = yield* Effect.forEach(files, actorVisibleLeaks(recordNeedles))
  const qa = yield* Effect.forEach(files, qaLeak(policy, everything))
  const bundle = yield* bundleOf(policy, files, [])
  const exported = pipe(bundle.files, Array.map(bundleLeak(everything)), Array.getSomes)

  return Seal.make({
    secrets: credentials.length,
    protectedRecords: records.length,
    retained,
    actorVisible: Array.flatten(visible),
    qa: Array.getSomes(qa),
    export: exported,
  })
})

/** Every finding of a seal as one list because any of them fails the run. */
export const sealFindings = (sealed: Seal) => pipe(sealed.retained, Array.appendAll(sealed.actorVisible), Array.appendAll(sealed.qa), Array.appendAll(sealed.export))

const markerPath = (output: string) => join(output, ownershipFile)

const lineagePath = (output: string) => join(output, lineageFile)

const alreadyOwned = governanceError("Output already carries an ownership marker; choose a fresh directory to preserve previous evidence")

/** Claims a fresh output directory at run start because only claimed directories may later be pruned. */
export const claimOwnership = Effect.fn("Acceptance.governance.claim")(function* (output: string, policy: EvidencePolicy, kind: typeof RunKindSchema.Type, startedAt: string) {
  const path = markerPath(output)
  const claimed = yield* fileExists(path)

  if (claimed) return yield* alreadyOwned

  const validated = yield* validatePolicy(policy)
  const run = yield* Effect.sync(randomUUID)
  const marker = OwnershipMarker.make({ format: "effect-domains-acceptance-ownership@1", run, application: validated.application, kind, startedAt, policy: validated })

  yield* encodedFile(OwnershipMarker)(path, marker)

  return marker
})

/** Records the lineage manifest after the final report is saved because its artifact hashes must cover the final evidence. */
export const recordLineage = Effect.fn("Acceptance.governance.recordLineage")(function* (output: string, marker: OwnershipMarker, facts: LineageFacts, sealed: Seal) {
  const files = yield* loadRun(output, marker.policy.rules)
  const artifacts = Array.map(files, artifactOf)

  const lineage = Lineage.make({
    format: "effect-domains-acceptance-lineage@1",
    run: marker.run,
    application: marker.application,
    kind: marker.kind,
    policyRevision: marker.policy.revision,
    startedAt: marker.startedAt,
    facts,
    artifacts,
    seal: sealed,
    pruned: [],
  })

  const path = lineagePath(output)

  yield* encodedFile(Lineage)(path, lineage)

  return lineage
})

/** Describes a replay's source by relative path, source run id, and hash because the source may later be pruned or copied. */
export const replaySource = Effect.fn("Acceptance.governance.replaySource")(function* (output: string, path: string) {
  const content = yield* readBytes(path)
  const marker = yield* pipe(path, dirname, markerPath, optionalFile(OwnershipMarker))
  const run = Option.map(marker, Struct.get("run"))

  return ReplaySource.make({ path: relative(output, path), run, sha256: sha256(content) })
})

const outsideDirectory = (file: string) => governanceError(`${file} is not a file inside the inspected directory`)

const insidePath = (directory: string, file: string) => {
  const absolute = resolve(directory, file)
  const path = relative(directory, absolute)
  const escapes = isAbsolute(path) || Text.startsWith("..")(path)
  const empty = Equal.equals(path, "")
  const invalid = escapes || empty

  return invalid ? pipe(file, outsideDirectory, Effect.fail) : Effect.succeed(path)
}

const noPolicy = governanceError("No recorded evidence policy: qa access requires a run-owned directory whose ownership marker records the policy; only the owner may read unowned evidence")

const exportOnly = governanceError("Export consumers can only read an export bundle (a directory with an export manifest.json), never a run directory")

const daysAfter = (startedAt: string) => (days: number) => pipe(DateTime.make(startedAt), Option.map(flow(DateTime.add({ days }), DateTime.formatIso)))

const ownedExpiry = (evidence: Classification) => (owned: OwnershipMarker) => pipe(
  evidence,
  ruleFor(owned.policy),
  Option.flatMap(Struct.get("retentionDays")),
  Option.flatMap(daysAfter(owned.startedAt)),
)

const expiryOf = (marker: Option.Option<OwnershipMarker>, evidence: Classification) => Option.flatMap(marker, ownedExpiry(evidence))

const listed = (consumer: Consumer, marker: Option.Option<OwnershipMarker>) => (file: LoadedFile) => {
  const access = Option.match(marker, { onNone: Function.constant<Access>("raw"), onSome: (owned) => accessFor(owned.policy, consumer, file.evidence) })

  return ListedArtifact.make({ path: file.path, evidence: file.evidence, bytes: file.content.length, sha256: sha256(file.content), access, expires: expiryOf(marker, file.evidence) })
}

const policyReference = (policy: EvidencePolicy) => PolicyReference.make({ application: policy.application, revision: policy.revision })

// Unowned evidence has no recorded policy, so owner views mask secrets with the local rules because owner access never digests protected records.
const unownedPolicy = EvidencePolicy.make({ application: "unowned", revision: "unowned", scope: "local-only", protectedProbes: [], protectedOperations: [], rules: localRules })

/** Owner views keep protected records but still mask secret-keyed JSON values because no consumer may read credentials. */
const ownerFile = (policy: EvidencePolicy) => (file: LoadedFile) => {
  const report = isReport(file.evidence)
  const log = Equal.equals(file.evidence, "server-log")
  const listing = ListedArtifact.make({ path: file.path, evidence: file.evidence, bytes: file.content.length, sha256: sha256(file.content), access: "raw", expires: Option.none() })
  const described = log ? utf8(file.content) : pretty(listing)
  const masked = pipe(file, viewBytes(policy, "owner"), Effect.map(utf8))

  return report ? masked : Effect.succeed(described)
}

const inventoryOf = Effect.fn("Acceptance.governance.inventory")(function* (directory: string, consumer: Consumer, marker: Option.Option<OwnershipMarker>, rules: ReadonlyArray<ClassRule>) {
  const all = yield* listFiles(directory)
  const files = yield* Effect.forEach(all, loadFile(directory, rules))
  const lineage = yield* pipe(directory, lineagePath, optionalFile(Lineage))

  return Inventory.make({
    consumer,
    policy: Option.map(marker, flow(Struct.get("policy"), policyReference)),
    run: Option.map(marker, Struct.get("run")),
    seal: Option.map(lineage, Struct.get("seal")),
    artifacts: Array.map(files, listed(consumer, marker)),
  })
})

const inspectExport = Effect.fn("Acceptance.governance.inspectExport")(function* (directory: string, file: Option.Option<string>) {
  const manifestPath = join(directory, manifestFile)
  const manifestPresent = yield* fileExists(manifestPath)

  if (!manifestPresent) return yield* exportOnly

  const manifest = yield* pipe(manifestPath, decodeFile(ExportManifest), Effect.mapError(Function.constant(exportOnly)))

  if (Option.isNone(file)) {
    const encoded = yield* pipe(manifest, Schema.encodeEffect(ExportManifest), Effect.mapError(describeFailure))

    return pretty(encoded)
  }

  const path = yield* insidePath(directory, file.value)
  const exported = Array.some(manifest.files, flow(Struct.get("path"), Equal.equals(path)))

  if (!exported) return yield* governanceError(`${path} is not part of the export bundle`)

  const exportedPath = join(directory, "files", path)
  const content = yield* readBytes(exportedPath)

  return utf8(content)
})

/** Inspects evidence as a declared consumer because owner, qa, and export access differ by evidence class. */
export const inspect = Effect.fn("Acceptance.governance.inspect")(function* (directory: string, consumer: Consumer, file: Option.Option<string>) {
  if (Equal.equals(consumer, "export")) return yield* inspectExport(directory, file)

  const marker = yield* pipe(directory, markerPath, optionalFile(OwnershipMarker))
  const unowned = Option.isNone(marker)
  const qa = Equal.equals(consumer, "qa")
  const refused = unowned && qa

  if (refused) return yield* noPolicy

  const rules = Option.match(marker, { onNone: Function.constant(localRules), onSome: flow(Struct.get("policy"), Struct.get("rules")) })

  if (Option.isNone(file)) {
    const inventory = yield* inventoryOf(directory, consumer, marker, rules)
    const encoded = yield* pipe(inventory, Schema.encodeEffect(Inventory), Effect.mapError(describeFailure))

    return pretty(encoded)
  }

  const path = yield* insidePath(directory, file.value)
  const loaded = yield* loadFile(directory, rules)(path)
  const qaPolicy = qa ? Option.map(marker, Struct.get("policy")) : Option.none<EvidencePolicy>()
  const ownerPolicy = pipe(marker, Option.map(Struct.get("policy")), Option.getOrElse(Function.constant(unownedPolicy)))

  if (Option.isNone(qaPolicy)) return yield* ownerFile(ownerPolicy)(loaded)

  const view = yield* qaView(qaPolicy.value)(loaded)

  return utf8(view)
})

const structuralDetectors: ReadonlyArray<readonly [string, RegExp]> = [
  ["secret-keyed JSON string", /"(password|token|secret|authorization|apiKey|api_key|cookie|sessionToken|accessToken)"\s*:\s*"(?!\[redacted:secret\])[^"]+"/i],
  ["bearer credential", /Bearer\s+[A-Za-z0-9._~+/-]{8,}/],
]

const detectorNames = Array.map(structuralDetectors, ([name]) => name)

const structuralFinding = (file: BundleFile) => {
  const text = utf8(file.content)
  const found = Array.some(structuralDetectors, ([, pattern]) => pattern.test(text))

  return found ? Option.some(`${file.path}: structural secret pattern`) : Option.none<string>()
}

const keyFinding = (needles: ReadonlyArray<Buffer>) => (file: BundleFile) => byNeedles(needles)(file.content) ? Option.some(`${file.path}: TYPESAFE_API_KEY`) : Option.none<string>()

const destinationExists = (destination: string) => governanceError(`Export destination ${destination} already exists; exports never overwrite`)

const unsafeBundle = (findings: ReadonlyArray<string>) => {
  const joined = Array.join(findings, "; ")

  return governanceError(`Export refused; secret scan findings: ${joined}`)
}

const byPath = (path: string) => (artifact: Artifact) => Equal.equals(artifact.path, path)

const matchesSeal = (lineage: Lineage) => (file: BundleFile) => pipe(lineage.artifacts, Array.findFirst(byPath(file.path)), Option.map(Struct.get("sha256")), Option.contains(file.sourceSha256))

const isGovernanceRecord = flow(Struct.get<BundleFile, "evidence">("evidence"), Equal.equals<Classification>("governance-record"))

const coversAll = (files: ReadonlyArray<BundleFile>) => (lineage: Lineage) => Array.every(files, matchesSeal(lineage))

const sourcesMatch = (lineage: Option.Option<Lineage>, files: ReadonlyArray<BundleFile>) => {
  const recorded = Array.filter(files, Predicate.not(isGovernanceRecord))

  return Option.exists(lineage, coversAll(recorded))
}

const exportedFile = (file: BundleFile) => ExportedFile.make({ path: file.path, evidence: file.evidence, sha256: sha256(file.content), sourceSha256: file.sourceSha256, bytes: file.content.length })

const bundledCopy = (destination: string) => (file: BundleFile) => {
  const target = join(destination, "files", file.path)

  return writeAtomically(target, file.content)
}

/**
 * Exports a run-owned directory under its recorded policy: JSON redacted for the export consumer, screenshots and logs
 * excluded unless explicitly included, and a manifest with hashes, exclusions, the policy revision, and a secret scan
 * of the exact bundle bytes; any finding refuses the export before anything is written.
 */
export const exportRun = Effect.fn("Acceptance.governance.export")(function* (directory: string, destination: string, include: ReadonlyArray<EvidenceClass>, apiKey: Option.Option<Redacted.Redacted<string>>) {
  const marker = yield* pipe(directory, markerPath, optionalFile(OwnershipMarker))

  if (Option.isNone(marker)) return yield* noPolicy

  const occupied = yield* fileExists(destination)
  const occupiedDirectory = yield* Effect.tryPromise({ try: () => readdir(destination).then(Function.constTrue, Function.constFalse), catch: describeFailure })
  const taken = occupied || occupiedDirectory

  if (taken) return yield* destinationExists(destination)

  const { policy } = marker.value
  const all = yield* listFiles(directory)
  const files = yield* Effect.forEach(all, loadFile(directory, policy.rules))
  const bundle = yield* bundleOf(policy, files, include)
  const keyNeedles = pipe(apiKey, Option.toArray, secretNeedles)
  const keyFindings = pipe(bundle.files, Array.map(keyFinding(keyNeedles)), Array.getSomes)
  const patternFindings = pipe(bundle.files, Array.map(structuralFinding), Array.getSomes)
  const findings = Array.appendAll(keyFindings, patternFindings)

  if (Array.isReadonlyArrayNonEmpty(findings)) return yield* unsafeBundle(findings)

  const lineage = yield* pipe(directory, lineagePath, optionalFile(Lineage))
  const exportedAt = yield* Effect.map(DateTime.now, DateTime.formatIso)
  const excludedClasses = pipe(bundle.excluded, Array.map(Struct.get("evidence")), Array.dedupe, Array.sort(Order.String))

  const secretScan = SecretScan.make({
    detectors: Array.prepend(detectorNames, "TYPESAFE_API_KEY bytes"),
    apiKeyChecked: Option.isSome(apiKey),
    findings,
    runSeal: Option.map(lineage, Struct.get("seal")),
    sourcesMatchSeal: sourcesMatch(lineage, bundle.files),
  })

  const manifest = ExportManifest.make({
    format: exportFormat,
    application: policy.application,
    source: basename(directory),
    run: marker.value.run,
    policy: policyReference(policy),
    exportedAt,
    files: Array.map(bundle.files, exportedFile),
    excluded: bundle.excluded,
    excludedClasses,
    secretScan,
  })

  const manifestPath = join(destination, manifestFile)

  yield* Effect.forEach(bundle.files, bundledCopy(destination), { discard: true })
  yield* encodedFile(ExportManifest)(manifestPath, manifest)

  return manifest
})

const OptionalLineageSchema = Schema.Option(Lineage)

class OwnedRun extends Schema.Class<OwnedRun>("OwnedRun")({
  directory: Schema.String,
  marker: OwnershipMarker,
  lineage: OptionalLineageSchema,
}) {}

const isMarker = (path: string) => pipe(path, basename, Equal.equals(ownershipFile))

const loadOwnership = (root: string) => Effect.fn("Acceptance.governance.loadOwnership")(function* (path: string) {
  const parent = dirname(path)
  const directory = join(root, parent)
  const markerFile = join(root, path)
  const marker = yield* decodeFile(OwnershipMarker)(markerFile)
  const lineage = yield* pipe(directory, lineagePath, optionalFile(Lineage))

  return OwnedRun.make({ directory, marker, lineage })
})

const pointsAt = (source: OwnedRun, replay: OwnedRun) => (reference: ReplaySource): boolean => {
  const sameRun = Option.contains(reference.run, source.marker.run)
  const referenced = resolve(replay.directory, reference.path)
  const sourceReport = join(source.directory, "run.json")
  const samePath = Equal.equals(referenced, sourceReport)

  return sameRun || samePath
}

const byReplayOf = (source: OwnedRun) => (replay: OwnedRun) => pipe(
  replay.lineage,
  Option.flatMap(flow(Struct.get("facts"), Struct.get("replaySource"))),
  Option.exists(pointsAt(source, replay)),
)

const byExpiry = (now: DateTime.Utc) => (expiry: string): boolean => pipe(DateTime.make(expiry), Option.exists((moment) => DateTime.isLessThanOrEqualTo(moment, now)))

const pruneEntry = (run: OwnedRun, now: DateTime.Utc, replays: ReadonlyArray<string>) => (file: LoadedFile) => {
  const owned = Option.some(run.marker)
  const expiry = expiryOf(owned, file.evidence)
  const expired = Option.exists(expiry, byExpiry(now))
  const sealed = Option.isSome(run.lineage)
  const deletable = expired && sealed
  const source = Equal.equals(file.path, "run.json") && Array.isReadonlyArrayNonEmpty(replays)
  const lineageNote = source ? `; replay source of ${Array.join(replays, ", ")}: lineage.json retained` : ""
  const kept = Option.match(expiry, { onNone: () => `${file.evidence}: kept indefinitely`, onSome: (moment) => expired ? "expired but unsealed: no lineage manifest, nothing deleted" : `retained until ${moment}` })

  return deletable
    ? PruneEntry.make({ path: file.path, evidence: file.evidence, action: "delete", reason: `expired ${Option.getOrElse(expiry, Function.constant(""))}${lineageNote}` })
    : PruneEntry.make({ path: file.path, evidence: file.evidence, action: "keep", reason: kept })
}

const isDeletion = (entry: PruneEntry) => Equal.equals(entry.action, "delete")

const noContent = new Uint8Array()

const byFilePath = (path: string) => (file: LoadedFile) => Equal.equals(file.path, path)

const prunedRecord = (files: ReadonlyArray<LoadedFile>, prunedAt: string) => (entry: PruneEntry) => {
  const content = pipe(files, Array.findFirst(byFilePath(entry.path)), Option.map(Struct.get("content")), Option.getOrElse(Function.constant(noContent)))

  return PrunedArtifact.make({ path: entry.path, evidence: entry.evidence, sha256: sha256(content), prunedAt })
}

const removeFile = (directory: string) => (entry: PruneEntry) => {
  const target = join(directory, entry.path)

  return Effect.tryPromise({ try: () => rm(target), catch: describeFailure })
}

const applyRun = Effect.fn("Acceptance.governance.applyRun")(function* (run: OwnedRun, entries: ReadonlyArray<PruneEntry>, files: ReadonlyArray<LoadedFile>, now: DateTime.Utc) {
  const deletions = Array.filter(entries, isDeletion)
  const lineage = Option.getOrUndefined(run.lineage)
  const nothing = Array.isReadonlyArrayEmpty(deletions)
  const skip = nothing || Predicate.isUndefined(lineage)

  if (skip) return

  const prunedAt = DateTime.formatIso(now)
  const records = Array.map(deletions, prunedRecord(files, prunedAt))
  const pruned = Array.appendAll(lineage.pruned, records)
  const updated = Lineage.make({ ...lineage, pruned })
  const path = lineagePath(run.directory)

  // The lineage is written before any deletion because a crash must never leave pruned artifacts without their lineage.
  yield* encodedFile(Lineage)(path, updated)
  yield* Effect.forEach(deletions, removeFile(run.directory), { discard: true })
})

const relativeDirectory = (root: string) => (owned: OwnedRun) => relative(root, owned.directory)

const planRun = (root: string, runs: ReadonlyArray<OwnedRun>, now: DateTime.Utc, apply: boolean) => Effect.fn("Acceptance.governance.planRun")(function* (run: OwnedRun) {
  const replays = pipe(runs, Array.filter(byReplayOf(run)), Array.map(relativeDirectory(root)))
  const paths = yield* listFiles(run.directory)
  const files = yield* Effect.forEach(paths, loadFile(run.directory, run.marker.policy.rules))
  const entries = Array.map(files, pruneEntry(run, now, replays))

  if (apply) yield* applyRun(run, entries, files, now)

  return PrunedRun.make({
    directory: relativeDirectory(root)(run) || ".",
    run: run.marker.run,
    status: Option.isSome(run.lineage) ? "sealed" : "unsealed",
    replaySourceOf: replays,
    entries,
  })
})

const directoryEntries = (root: string) => Effect.tryPromise({ try: () => readdir(root, { withFileTypes: true }), catch: describeFailure })

const isDirectoryEntry = (entry: Dirent) => entry.isDirectory()

const within = (directory: string) => (path: string): boolean => Equal.equals(path, directory) || Text.startsWith(`${directory}/`)(path)

const byUnowned = (root: string, owned: ReadonlyArray<string>) => (name: string): boolean => {
  const directory = join(root, name)

  return !Array.some(owned, within(directory))
}

/**
 * Plans (and with `apply` performs) retention pruning under a root: only directories carrying an ownership marker are
 * considered, only sealed runs lose expired artifacts, governance records are never deleted, and a replay source's
 * lineage is kept because the replay's own lineage references it.
 */
export const prune = Effect.fn("Acceptance.governance.prune")(function* (root: string, now: DateTime.Utc, apply: boolean) {
  const paths = yield* listFiles(root)
  const markers = Array.filter(paths, isMarker)
  const runs = yield* Effect.forEach(markers, loadOwnership(root))
  const planned = yield* Effect.forEach(runs, planRun(root, runs, now, apply))
  const children = yield* directoryEntries(root)
  const ownedDirectories = Array.map(runs, Struct.get("directory"))
  const unowned = pipe(children, Array.filter(isDirectoryEntry), Array.map(Struct.get("name")), Array.filter(byUnowned(root, ownedDirectories)), Array.sort(Order.String))
  const rootDirectory = join(root, ".")
  const rootOwned = Array.contains(ownedDirectories, rootDirectory)

  return PrunePlan.make({ root, now: DateTime.formatIso(now), applied: apply, runs: planned, unowned: rootOwned ? [] : unowned })
})
