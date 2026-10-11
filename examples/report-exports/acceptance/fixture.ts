import { Database } from "bun:sqlite"
import { Array, DateTime, Effect, Equal, Function, HashMap, Layer, Option, Redacted, Ref, Schema, flow, pipe } from "effect"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { AcceptanceError, Candidate, FixtureRuntime, PayloadSchema, PreparedFixture, ProbeRecord, ProbeTarget, Scenario, Submission, type Payload } from "@effect-domains/acceptance/model"
import { ServerSpec, call, serve, startWorker } from "@effect-domains/acceptance/server"

type Token = Redacted.Redacted<string>

const binding = "acme-exports"

const bindings = [binding]

const actors = ["editor-session", "reader-session"]

const storedExports = "stored-exports"

const probes = [storedExports]

const tenantFact = "tenant.id"

const facts = [tenantFact]

const tenant = "acme"

const operation = "ReportExport.GenerateDiscard"

const TokenSchema = Schema.Redacted(Schema.String)

const ActorTokenSchema = Schema.Option(TokenSchema)

const IdentifiersSchema = Schema.Array(Schema.String)

/** What the fixture keeps per prepared application because probes need the private store and sessions are secrets. */
class Credentials extends Schema.Class<Credentials>("Credentials")({
  password: TokenSchema,
  editor: TokenSchema,
  actor: ActorTokenSchema,
  database: Schema.String,
}) {}

const LoginSchema = Schema.Struct({ token: Schema.String })

interface Login extends Schema.Schema.Type<typeof LoginSchema> {}

const StoredRequestSchema = Schema.fromJsonString(Schema.Unknown)

const StoredExportSchema = Schema.Struct({ id: Schema.String, request: StoredRequestSchema })

export interface StoredExport extends Schema.Schema.Type<typeof StoredExportSchema> {}

export const StoredExportsSchema = Schema.Array(StoredExportSchema)

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

const unsupportedProbe = (target: ProbeTarget) => `The Report Exports fixture implements only ${storedExports}; ${target.probe} is unsupported`

const now = Effect.map(DateTime.now, DateTime.formatIso)

const loginActor = (url: string, password: Token, editor: Token) => (username: string) => {
  const reused = Effect.succeed(editor)
  const editing = Equal.equals(username, "alice")
  const issued = editing ? reused : login(url, username, password)

  return Effect.asSome(issued)
}

const storedExportsQuery = "SELECT id, request FROM report_export_executions WHERE \"tenantId\" = ? ORDER BY id"

const readOnly = { readonly: true }

const openDatabase = (path: string) => Effect.try({ try: () => new Database(path, readOnly), catch: describeFailure })

const closeDatabase = (database: Database) => Effect.sync(() => database.close())

const selectRows = (query: string, subject: string) => (database: Database) => Effect.try({ try: () => database.query(query).all(subject), catch: describeFailure })

const decodeExports = flow(Schema.decodeUnknownEffect(StoredExportsSchema), Effect.mapError(describeFailure))

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
    const editorToken = Option.some(editor)

    yield* expect(url, operation, seededExport, editorToken)

    const account = HashMap.get(actorAccounts, actor)

    const actorToken = yield* Option.match(account, {
      onNone: Function.constant(Effect.succeedNone),
      onSome: loginActor(url, password, editor),
    })

    const database = applicationDatabase(directory)
    const stored = Credentials.make({ password, editor, actor: actorToken, database })
    const remembered = remember(url, stored)

    yield* Effect.acquireRelease(remembered, forget(url))

    return PreparedFixture.make({ binding: scenario.fixture, url, actor, facts: { [tenantFact]: tenant }, tracked: [tenant] })
  })

  const session = Effect.fn("ReportExportsAcceptance.fixture.session")(function* (fixture: PreparedFixture) {
    const stored = yield* credentials(fixture)

    return stored.actor
  })

  const secrets = Effect.fn("ReportExportsAcceptance.fixture.secrets")(function* (fixture: PreparedFixture) {
    const stored = yield* credentials(fixture)
    const actorTokens = Option.toArray(stored.actor)
    const issued = Array.prepend(actorTokens, stored.editor)

    return Array.prepend(issued, stored.password)
  })

  const probe = Effect.fn("ReportExportsAcceptance.fixture.probe")(function* (fixture: PreparedFixture, target: ProbeTarget) {
    const stored = yield* credentials(fixture)
    const listed = Equal.equals(target.probe, storedExports)

    if (listed) return yield* observeStoredExports(stored, target)

    return yield* pipe(target, unsupportedProbe, fixtureError)
  })

  const direct = Effect.fn("ReportExportsAcceptance.fixture.direct")(function* (fixture: PreparedFixture, candidate: Candidate) {
    const stored = yield* credentials(fixture)
    const at = yield* now
    const response = yield* call(fixture.url, candidate.operation, candidate.input, stored.actor)

    return Submission.make({ inputCase: candidate.inputCase, operation: candidate.operation, input: candidate.input, status: response.status, result: response.result, error: response.error, at })
  })

  return FixtureRuntime.of({ bindings, actors, facts, probes, prepare, probe, direct, session, secrets })
})

const runtimeEffect = runtime()

export const fixtureLayer = Layer.effect(FixtureRuntime, runtimeEffect)
