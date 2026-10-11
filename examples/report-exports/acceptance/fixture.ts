import { Database } from "bun:sqlite"
import { Array, DateTime, Effect, Equal, Function, HashMap, Layer, Option, Redacted, Ref, Schema, String as Text, Struct, flow, pipe } from "effect"
import { createHash, randomBytes } from "node:crypto"
import { realpath } from "node:fs/promises"
import { join, sep } from "node:path"
import { AcceptanceError, Candidate, FixtureRuntime, PayloadSchema, PreparedFixture, ProbeRecord, ProbeTarget, Scenario, Submission, type Payload } from "@effect-domains/acceptance/model"
import { CallResponse, ServerSpec, call, serve, startWorker } from "@effect-domains/acceptance/server"

type Token = Redacted.Redacted<string>

const revision = "isolated-report-exports@2"

const binding = "acme-exports"

const bindings = [binding]

const actors = ["editor-session", "reader-session"]

const storedExports = "stored-exports"

const exportStatus = "export-status"

const probes = [storedExports, exportStatus]

const tenantFact = "tenant.id"

const facts = [tenantFact]

const tenant = "acme"

const operation = "ReportExport.GenerateDiscard"

const pollOperation = "ReportExport.Poll"

const TokenSchema = Schema.Redacted(Schema.String)

const ActorTokenSchema = Schema.Option(TokenSchema)

const IdentifiersSchema = Schema.Array(Schema.String)

/** What the fixture keeps per prepared application because probes need the operator session, the private stores, and the executions that existed before the scenario. */
class Credentials extends Schema.Class<Credentials>("Credentials")({
  password: TokenSchema,
  editor: TokenSchema,
  admin: TokenSchema,
  actor: ActorTokenSchema,
  database: Schema.String,
  output: Schema.String,
  artifacts: Schema.String,
  prepared: IdentifiersSchema,
}) {}

const LoginSchema = Schema.Struct({ token: Schema.String })

interface Login extends Schema.Schema.Type<typeof LoginSchema> {}

const StoredRequestSchema = Schema.fromJsonString(Schema.Unknown)

const StoredExportSchema = Schema.Struct({ id: Schema.String, request: StoredRequestSchema })

interface StoredExport extends Schema.Schema.Type<typeof StoredExportSchema> {}

const StoredExportsSchema = Schema.Array(StoredExportSchema)

const ExecutionIdSchema = Schema.Struct({ id: Schema.String })

interface ExecutionId extends Schema.Schema.Type<typeof ExecutionIdSchema> {}

const ExecutionIdsSchema = Schema.Array(ExecutionIdSchema)

const ArtifactNamedSchema = Schema.Struct({ _tag: Schema.Literal("Succeeded"), artifactPath: Schema.String })

interface ArtifactNamed extends Schema.Schema.Type<typeof ArtifactNamedSchema> {}

/** No execution of the subject appeared since preparation, because the watched request has not reached the store yet. */
export const UndiscoveredSchema = Schema.TaggedStruct("Undiscovered", {})

/** Several executions appeared since preparation, because the probe must report rather than guess which one the scenario created. */
const AmbiguousSchema = Schema.TaggedStruct("Ambiguous", { executions: IdentifiersSchema })

/** The returned artifact path resolves outside the private output directory, because such a path is reported, never opened. */
export const OutsideArtifactSchema = Schema.TaggedStruct("Outside", { path: Schema.String })

/** The artifact bytes as read (text and SHA-256) and the path of the copy retained with the scenario evidence. */
export const RetainedArtifactSchema = Schema.TaggedStruct("Retained", { path: Schema.String, content: Schema.String, sha256: Schema.String, retained: Schema.String })

const ServerEnvironmentSchema = Schema.Record(Schema.String, Schema.String)

const applicationDatabase = (directory: string) => join(directory, "application.sqlite")

const outputDirectory = (directory: string) => join(directory, "artifacts")

// Every store and the artifact directory live in the private directory because shared state would leak exports and sessions between fixtures.
const isolatedEnvironment = (password: Token, directory: string) => ServerEnvironmentSchema.make({
  REPORT_EXPORTS_DB: applicationDatabase(directory),
  REPORT_EXPORTS_EXECUTION_DB: join(directory, "execution.sqlite"),
  REPORT_EXPORTS_IDENTITY_DB: join(directory, "identity.sqlite"),
  REPORT_EXPORTS_OUTPUT_DIR: outputDirectory(directory),
  EFFECT_DOMAINS_DEMO_PASSWORD: Redacted.value(password),
})

// The server runs as a cluster client because the documented multi-process topology leaves workflow execution to a separate runner.
const serverEnvironment = (password: Token) => (directory: string) => {
  const isolated = isolatedEnvironment(password, directory)

  return ServerEnvironmentSchema.make({ ...isolated, EFFECT_CLUSTER_MODE: "client" })
}

// The worker shares every store with the server because the documented topology coordinates runners through the same execution database.
const workerEnvironment = (password: Token) => (directory: string, port: number) => {
  const isolated = isolatedEnvironment(password, directory)
  const clusterPort = String(port)

  return ServerEnvironmentSchema.make({ ...isolated, EFFECT_CLUSTER_MODE: "runner", EFFECT_CLUSTER_PORT: clusterPort })
}

const generatePassword = () => randomBytes(24).toString("base64url")

const fixtureError = (message: string) => AcceptanceError.make({ boundary: "fixture", message })

const describeFailure = flow(String, fixtureError)

// Secret-bearing boundaries use fixed messages because their causes can retain the environment, request body, or issued token.
const loginFailed = pipe("Fixture login reply did not contain a session token", fixtureError, Function.constant)

const failedMessage = (name: string, status: number) => `Fixture call ${name} failed with HTTP ${String(status)}`

const expect = Effect.fn("ReportExportsAcceptance.fixture.expect")(function* (url: string, name: string, input: Payload, token: Option.Option<Token>) {
  const response = yield* call(url, name, input, token)
  const succeeded = Equal.equals(response.status, 200)
  const failure = pipe(failedMessage(name, response.status), fixtureError)
  const result = yield* succeeded ? Effect.succeed(response.result) : Effect.fail(failure)

  return yield* pipe(result, Effect.fromOption, Effect.mapError(Function.constant(failure)))
})

const anonymous: Option.Option<Token> = Option.none()

const login = Effect.fn("ReportExportsAcceptance.fixture.login")(function* (url: string, username: string, password: Token) {
  const secret = Redacted.value(password)
  const input = PayloadSchema.make({ username, password: secret })
  const result = yield* expect(url, "identity.login", input, anonymous)
  const decoded = Schema.decodeUnknownEffect(LoginSchema)(result)
  const session: Login = yield* pipe(decoded, Effect.mapError(loginFailed))

  return Redacted.make(session.token)
})

// The seeded export makes the before probe answer with a stored request because an empty store would let a lost or rewritten request pass unnoticed.
const seededExport = PayloadSchema.make({
  report: {
    reportId: "acme-2026-q3-close",
    reportingPeriod: { startsAt: "2026-07-01T00:00:00.000Z", endsAt: "2026-10-01T00:00:00.000Z" },
    currency: "USD",
    releasePolicy: "automatic",
  },
  lines: [
    { accountCode: "4000", description: "Consulting revenue", direction: "credit", amountMinor: 250_000 },
    { accountCode: "1100", description: "Receivable from Initech", direction: "debit", amountMinor: 250_000 },
  ],
})

const actorAccounts = HashMap.make(["editor-session", "alice"], ["reader-session", "bob"])

const unknownMessage = (kind: string, name: string) => `Unknown ${kind} binding ${name}`

const requireKnown = (known: ReadonlyArray<string>, kind: string, name: string) => {
  const bound = Array.contains(known, name)
  const failure = pipe(unknownMessage(kind, name), fixtureError, Effect.fail)

  return bound ? Effect.void : failure
}

const missingCredentials = fixtureError("Fixture credentials are not available; the fixture was released or never prepared")

const unsupportedProbe = (target: ProbeTarget) => `The Report Exports fixture implements only ${storedExports} and ${exportStatus}; ${target.probe} is unsupported`

const now = Effect.map(DateTime.now, DateTime.formatIso)

const loginActor = (url: string, password: Token, editor: Token) => (username: string) => {
  const reused = Effect.succeed(editor)
  const editing = Equal.equals(username, "alice")
  const issued = editing ? reused : login(url, username, password)

  return Effect.asSome(issued)
}

const storedExportsQuery = "SELECT id, request FROM report_export_executions WHERE \"tenantId\" = ? ORDER BY id"

const executionIdsQuery = "SELECT id FROM report_export_executions WHERE \"tenantId\" = ? ORDER BY id"

const readOnly = { readonly: true }

const openDatabase = (path: string) => Effect.try({ try: () => new Database(path, readOnly), catch: describeFailure })

const closeDatabase = (database: Database) => Effect.sync(() => database.close())

const selectRows = (query: string, subject: string) => (database: Database) => Effect.try({ try: () => database.query(query).all(subject), catch: describeFailure })

const decodeExports = flow(Schema.decodeUnknownEffect(StoredExportsSchema), Effect.mapError(describeFailure))

const decodeExecutionIds = flow(Schema.decodeUnknownEffect(ExecutionIdsSchema), Effect.mapError(describeFailure))

const readRows = (path: string, query: string, subject: string) => {
  const opened = openDatabase(path)

  return pipe(
    Effect.acquireRelease(opened, closeDatabase),
    Effect.flatMap(selectRows(query, subject)),
    Effect.scoped,
  )
}

// The store is read directly because the application publishes no list of accepted export requests to observe.
const readStoredExports = Effect.fn("ReportExportsAcceptance.fixture.storedExports")(function* (path: string, subject: string) {
  const rows = yield* readRows(path, storedExportsQuery, subject)
  const decoded: ReadonlyArray<StoredExport> = yield* decodeExports(rows)

  return decoded
})

// Execution ids are discovered in the store because the operator poll needs an id and the application publishes no list of executions.
const readExecutionIds = Effect.fn("ReportExportsAcceptance.fixture.executionIds")(function* (path: string, subject: string) {
  const rows = yield* readRows(path, executionIdsQuery, subject)
  const decoded: ReadonlyArray<ExecutionId> = yield* decodeExecutionIds(rows)

  return Array.map(decoded, Struct.get("id"))
})

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const utf8 = new TextDecoder()

const resolvedPath = (path: string) => Effect.tryPromise({ try: () => realpath(path), catch: describeFailure })

const readBytes = (path: string) => Effect.tryPromise({ try: () => Bun.file(path).bytes(), catch: describeFailure })

const storeBytes = (path: string, bytes: Uint8Array) => pipe(
  Effect.tryPromise({ try: () => Bun.write(path, bytes), catch: describeFailure }),
  Effect.asVoid,
)

/**
 * Reads the immutable artifact only inside the fixture's private output directory because a returned path elsewhere is itself a defect to
 * report, never a file to open; the bytes are hashed and a copy named by execution and hash is retained with the scenario evidence.
 */
const retainArtifact = (stored: Credentials, executionId: string) => Effect.fn("ReportExportsAcceptance.fixture.retainArtifact")(function* (succeeded: ArtifactNamed) {
  const output = yield* resolvedPath(stored.output)
  const resolved = yield* resolvedPath(succeeded.artifactPath)
  const inside = Text.startsWith(`${output}${sep}`)(resolved)
  const outside = OutsideArtifactSchema.make({ path: resolved })

  if (!inside) return PayloadSchema.make(outside)

  const bytes = yield* readBytes(resolved)
  const sha256 = sha256Of(bytes)
  const content = utf8.decode(bytes)
  const retained = join(stored.artifacts, `artifact-${executionId}-${sha256}.json`)

  yield* storeBytes(retained, bytes)

  const evidence = RetainedArtifactSchema.make({ path: resolved, content, sha256, retained })

  return PayloadSchema.make(evidence)
})

const decodePayload = Schema.decodeUnknownOption(PayloadSchema)

const decodeSucceeded = Schema.decodeUnknownOption(ArtifactNamedSchema)

const withExecution = (result: Payload, executionId: string) => (artifact: Option.Option<Payload>) => Option.match(artifact, {
  onNone: () => PayloadSchema.make({ ...result, executionId }),
  onSome: (evidence) => PayloadSchema.make({ ...result, executionId, artifact: evidence }),
})

// A succeeded poll carries the artifact evidence beside the poll fields because the evaluator must judge the bytes the result names.
const polledResult = (stored: Credentials, executionId: string) => Effect.fn("ReportExportsAcceptance.fixture.polledResult")(function* (result: Payload) {
  const succeeded = decodeSucceeded(result)
  const retaining = Option.map(succeeded, retainArtifact(stored, executionId))
  const artifact = yield* Effect.transposeOption(retaining)

  return withExecution(result, executionId)(artifact)
})

const statusRecord = (target: ProbeTarget, at: string, response: CallResponse) => (result: Option.Option<Payload>) => ProbeRecord.make({
  probe: target.probe,
  phase: target.phase,
  subject: target.subject,
  actor: "fixture-admin-poll",
  at,
  status: response.status,
  result,
  error: response.error,
})

const pollExecution = Effect.fn("ReportExportsAcceptance.fixture.pollExecution")(function* (url: string, stored: Credentials, target: ProbeTarget, executionId: string) {
  const input = PayloadSchema.make({ executionId })
  const admin = Option.some(stored.admin)
  const response = yield* call(url, pollOperation, input, admin)
  const at = yield* now
  const answered = Equal.equals(response.status, 200)
  const decoded = Option.flatMap(response.result, decodePayload)
  const result = Option.filter(decoded, Function.constant(answered))
  const composing = Option.map(result, polledResult(stored, executionId))
  const composed = yield* Effect.transposeOption(composing)

  return statusRecord(target, at, response)(composed)
})

const storeRecord = (target: ProbeTarget, at: string) => (result: Payload) => ProbeRecord.make({ probe: target.probe, phase: target.phase, subject: target.subject, actor: "fixture-store-probe", at, status: 200, result: Option.some(result), error: Option.none() })

const discoveredRecord = Effect.fn("ReportExportsAcceptance.fixture.discoveredRecord")(function* (target: ProbeTarget, result: Payload) {
  const at = yield* now

  return storeRecord(target, at)(result)
})

const undiscovered = UndiscoveredSchema.make({})

const undiscoveredResult = PayloadSchema.make(undiscovered)

const ambiguousStatus = (executions: ReadonlyArray<string>) => AmbiguousSchema.make({ executions })

const ambiguous = flow(ambiguousStatus, PayloadSchema.make)

const discoveredStatus = (fixture: PreparedFixture, stored: Credentials, target: ProbeTarget) => (executions: Array.NonEmptyReadonlyArray<string>) => {
  const others = Array.tailNonEmpty(executions)
  const single = Array.isReadonlyArrayEmpty(others)
  const first = Array.headNonEmpty(executions)
  const several = ambiguous(executions)

  return single ? pollExecution(fixture.url, stored, target, first) : discoveredRecord(target, several)
}

/**
 * Observes the one execution of the subject tenant that did not exist when the fixture was prepared, through the documented operator poll,
 * because acceptance of a generation request is not its completion; zero or several new executions are reported, never guessed between.
 */
const observeExportStatus = Effect.fn("ReportExportsAcceptance.fixture.exportStatus")(function* (fixture: PreparedFixture, stored: Credentials, target: ProbeTarget) {
  const ids = yield* readExecutionIds(stored.database, target.subject)
  const fresh = Array.difference(ids, stored.prepared)
  const none = discoveredRecord(target, undiscoveredResult)

  return yield* Array.match(fresh, {
    onEmpty: Function.constant(none),
    onNonEmpty: discoveredStatus(fixture, stored, target),
  })
})

const observeStoredExports = Effect.fn("ReportExportsAcceptance.fixture.observeStoredExports")(function* (stored: Credentials, target: ProbeTarget) {
  const at = yield* now
  const rows = yield* readStoredExports(stored.database, target.subject)

  return ProbeRecord.make({ probe: target.probe, phase: target.phase, subject: target.subject, actor: "fixture-store-probe", at, status: 200, result: Option.some(rows), error: Option.none() })
})

const emptyStore = HashMap.empty<string, Credentials>()

const runtime = Effect.fn("ReportExportsAcceptance.fixture.runtime")(function* () {
  const store = yield* Ref.make(emptyStore)

  const credentials = Effect.fn("ReportExportsAcceptance.fixture.credentials")(function* (fixture: PreparedFixture) {
    const entries = yield* Ref.get(store)

    return yield* pipe(HashMap.get(entries, fixture.url), Effect.fromOption, Effect.mapError(Function.constant(missingCredentials)))
  })

  const forget = (url: string) => pipe(store, Ref.update(HashMap.remove(url)), Function.constant)
  const remember = (url: string, stored: Credentials) => Ref.update(store, HashMap.set(url, stored))

  const prepare = Effect.fn("ReportExportsAcceptance.fixture.prepare")(function* (scenario: Scenario, actor: string, artifacts: string) {
    yield* requireKnown(bindings, "fixture", scenario.fixture)
    yield* requireKnown(actors, "actor", actor)

    const generated = generatePassword()
    const password = Redacted.make(generated)
    const spec = ServerSpec.make({ application: "report-exports", entry: "examples/report-exports/main.ts", prefix: "report-exports-acceptance-", artifacts })
    const { url, directory } = yield* serve(spec, serverEnvironment(password))

    yield* startWorker(spec, directory, workerEnvironment(password))

    const editor = yield* login(url, "alice", password)
    const admin = yield* login(url, "admin", password)
    const editorToken = Option.some(editor)

    yield* expect(url, operation, seededExport, editorToken)

    const account = HashMap.get(actorAccounts, actor)

    const actorToken = yield* Option.match(account, {
      onNone: Function.constant(Effect.succeedNone),
      onSome: loginActor(url, password, editor),
    })

    const database = applicationDatabase(directory)
    const output = outputDirectory(directory)
    const prepared = yield* readExecutionIds(database, tenant)
    const stored = Credentials.make({ password, editor, admin, actor: actorToken, database, output, artifacts, prepared })
    const remembered = remember(url, stored)

    yield* Effect.acquireRelease(remembered, forget(url))

    return PreparedFixture.make({ binding: scenario.fixture, revision, url, actor, facts: { [tenantFact]: tenant }, tracked: [tenant] })
  })

  const session = Effect.fn("ReportExportsAcceptance.fixture.session")(function* (fixture: PreparedFixture) {
    const stored = yield* credentials(fixture)

    return stored.actor
  })

  const secrets = Effect.fn("ReportExportsAcceptance.fixture.secrets")(function* (fixture: PreparedFixture) {
    const stored = yield* credentials(fixture)
    const actorTokens = Option.toArray(stored.actor)
    const issued = Array.prepend(actorTokens, stored.editor)
    const operated = Array.prepend(issued, stored.admin)

    return Array.prepend(operated, stored.password)
  })

  const probe = Effect.fn("ReportExportsAcceptance.fixture.probe")(function* (fixture: PreparedFixture, target: ProbeTarget) {
    const stored = yield* credentials(fixture)
    const watched = Equal.equals(target.probe, exportStatus)
    const listed = Equal.equals(target.probe, storedExports)

    if (watched) return yield* observeExportStatus(fixture, stored, target)

    if (listed) return yield* observeStoredExports(stored, target)

    return yield* pipe(target, unsupportedProbe, fixtureError)
  })

  const direct = Effect.fn("ReportExportsAcceptance.fixture.direct")(function* (fixture: PreparedFixture, candidate: Candidate) {
    const stored = yield* credentials(fixture)
    const at = yield* now
    const response = yield* call(fixture.url, candidate.operation, candidate.input, stored.actor)

    return Submission.make({ inputCase: candidate.inputCase, operation: candidate.operation, input: candidate.input, status: response.status, result: response.result, error: response.error, at, exchange: Option.none(), feedback: Option.none() })
  })

  return FixtureRuntime.of({ revision, bindings, actors, facts, probes, prepare, probe, direct, session, secrets })
})

const runtimeEffect = runtime()

export const fixtureLayer = Layer.effect(FixtureRuntime, runtimeEffect)
