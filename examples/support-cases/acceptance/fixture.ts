import { Array, DateTime, Effect, Equal, Function, HashMap, Layer, Option, Record, Redacted, Ref, Schema, Struct, flow, pipe } from "effect"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { AcceptanceError, Candidate, FixtureRuntime, PayloadSchema, PreparedFixture, ProbeRecord, ProbeTarget, Scenario, Submission, type Payload } from "@effect-domains/acceptance/model"
import { ServerSpec, call, serve } from "@effect-domains/acceptance/server"

type Token = Redacted.Redacted<string>

const bindings = ["support-baseline", "support-target-open", "support-target-triaged"]

const actors = ["public-operator", "admin-session", "reader-session", "anonymous"]

const probes = ["case-detail", "audit-trail"]

const facts = ["customer.id", "customer.name", "agent.on-duty.id", "agent.on-duty.name", "agent.off-duty.id", "sentinel.case.id", "target.id", "target.version"]

const TokenSchema = Schema.Redacted(Schema.String)

const ActorTokenSchema = Schema.Option(TokenSchema)

class Credentials extends Schema.Class<Credentials>("Credentials")({
  password: TokenSchema,
  admin: TokenSchema,
  actor: ActorTokenSchema,
}) {}

const CaseRowSchema = Schema.Struct({ id: Schema.String, version: Schema.Int })

interface CaseRow extends Schema.Schema.Type<typeof CaseRowSchema> {}

const LoginSchema = Schema.Struct({ token: Schema.String })

interface Login extends Schema.Schema.Type<typeof LoginSchema> {}

const ServerEnvironmentSchema = Schema.Record(Schema.String, Schema.String)

const applicationDatabase = (directory: string) => join(directory, "application.sqlite")

// The application and identity stores live in the private directory because a shared identity store would leak state between fixtures.
const serverEnvironment = (password: Token) => (directory: string) => ServerEnvironmentSchema.make({
  SUPPORT_CASES_DB: applicationDatabase(directory),
  SUPPORT_CASES_IDENTITY_DB: join(directory, "identity.sqlite"),
  EFFECT_DOMAINS_DEMO_PASSWORD: Redacted.value(password),
})

const generatePassword = () => randomBytes(24).toString("base64url")

const fixtureError = (message: string) => AcceptanceError.make({ boundary: "fixture", message })

const describeFailure = flow(String, fixtureError)

// Secret-bearing boundaries use fixed messages because their causes can retain the environment, request body, or issued token.
const loginFailed = pipe("Fixture login reply did not contain a session token", fixtureError, Function.constant)

const failedMessage = (operation: string, status: number) => `Fixture call ${operation} failed with HTTP ${String(status)}`

const expect = Effect.fn("SupportAcceptance.fixture.expect")(function* (url: string, operation: string, input: Payload, token: Option.Option<Token>) {
  const response = yield* call(url, operation, input, token)
  const succeeded = Equal.equals(response.status, 200)
  const failure = pipe(failedMessage(operation, response.status), fixtureError)
  const result = yield* succeeded ? Effect.succeed(response.result) : Effect.fail(failure)

  return yield* pipe(result, Effect.fromOption, Effect.mapError(Function.constant(failure)))
})

const anonymous: Option.Option<Token> = Option.none()

const caseCall = Effect.fn("SupportAcceptance.fixture.case")(function* (url: string, operation: string, input: Payload) {
  const result = yield* expect(url, operation, input, anonymous)
  const decoded = Schema.decodeUnknownEffect(CaseRowSchema)(result)
  const row: CaseRow = yield* pipe(decoded, Effect.mapError(describeFailure))

  return row
})

const login = Effect.fn("SupportAcceptance.fixture.login")(function* (url: string, username: string, password: Token) {
  const secret = Redacted.value(password)
  const input = PayloadSchema.make({ username, password: secret })
  const result = yield* expect(url, "identity.login", input, anonymous)
  const decoded = Schema.decodeUnknownEffect(LoginSchema)(result)
  const session: Login = yield* pipe(decoded, Effect.mapError(loginFailed))

  return Redacted.make(session.token)
})

const customers = [
  PayloadSchema.make({ id: "acme", name: "Acme Industries" }),
  PayloadSchema.make({ id: "globex", name: "Globex Corporation" }),
]

const agents = [
  PayloadSchema.make({ id: "dana", name: "Dana Ortiz", onDuty: true }),
  PayloadSchema.make({ id: "omar", name: "Omar Haddad", onDuty: false }),
]

const sentinelOpen = PayloadSchema.make({ customerId: "globex", subject: "Invoice totals do not match the statement" })

const targetOpen = PayloadSchema.make({ customerId: "acme", subject: "Password reset email never arrives" })

const advance = (row: CaseRow, action: string, details: Payload) => PayloadSchema.make({ ...details, caseId: row.id, expectedVersion: row.version, action })

const noDetails = PayloadSchema.make({})

const triageNote = PayloadSchema.make({ note: "Statement export compared with invoice ledger." })

const assignDana = PayloadSchema.make({ assignedAgentId: "dana" })

const seedEntity = (url: string, operation: string) => (input: Payload) => expect(url, operation, input, anonymous)

const seedSentinel = Effect.fn("SupportAcceptance.fixture.sentinel")(function* (url: string) {
  const opened = yield* caseCall(url, "support.openCase", sentinelOpen)
  const triage = advance(opened, "triage", triageNote)
  const triaged = yield* caseCall(url, "support.advanceCase", triage)
  const assign = advance(triaged, "assign", assignDana)

  return yield* caseCall(url, "support.advanceCase", assign)
})

const seedTarget = Effect.fn("SupportAcceptance.fixture.target")(function* (url: string, triaged: boolean) {
  const opened = yield* caseCall(url, "support.openCase", targetOpen)
  const input = advance(opened, "triage", noDetails)
  const triage = caseCall(url, "support.advanceCase", input)

  return yield* triaged ? triage : Effect.succeed(opened)
})

const seedTargetFor = (url: string, binding: string) => {
  const baseline = Equal.equals(binding, "support-baseline")
  const triaged = Equal.equals(binding, "support-target-triaged")
  const seeded = pipe(seedTarget(url, triaged), Effect.asSome)

  return baseline ? Effect.succeedNone : seeded
}

const actorAccounts = HashMap.make(["admin-session", "admin"], ["reader-session", "bob"])

const unknownMessage = (kind: string, name: string) => `Unknown ${kind} binding ${name}`

const requireKnown = (known: ReadonlyArray<string>, kind: string, name: string) => {
  const bound = Array.contains(known, name)
  const failure = pipe(unknownMessage(kind, name), fixtureError, Effect.fail)

  return bound ? Effect.void : failure
}

const FactValueSchema = Schema.Union([Schema.String, Schema.Int])

const FactsSchema = Schema.Record(Schema.String, FactValueSchema)

type Facts = typeof FactsSchema.Type

const withTarget = (known: Facts) => (row: CaseRow) => FactsSchema.make({ ...known, "target.id": row.id, "target.version": row.version })

const fixtureFacts = (sentinel: CaseRow, target: Option.Option<CaseRow>) => {
  const known = FactsSchema.make({
    "customer.id": "acme",
    "customer.name": "Acme Industries",
    "agent.on-duty.id": "dana",
    "agent.on-duty.name": "Dana Ortiz",
    "agent.off-duty.id": "omar",
    "sentinel.case.id": sentinel.id,
  })

  return Option.match(target, { onNone: Function.constant(known), onSome: withTarget(known) })
}

const missingCredentials = fixtureError("Fixture credentials are not available; the fixture was released or never prepared")

const ProbeActorSchema = Schema.Literals(["fixture-public-probe", "fixture-admin-probe"])

const probeOperations = HashMap.make(["case-detail", "support.caseDetail"], ["audit-trail", "support.auditTrail"])

const now = Effect.map(DateTime.now, DateTime.formatIso)

const loginActor = (url: string, password: Token) => (username: string) => pipe(login(url, username, password), Effect.asSome)

const emptyStore = HashMap.empty<string, Credentials>()

const runtime = Effect.fn("SupportAcceptance.fixture.runtime")(function* () {
  const store = yield* Ref.make(emptyStore)

  const credentials = Effect.fn("SupportAcceptance.fixture.credentials")(function* (fixture: PreparedFixture) {
    const entries = yield* Ref.get(store)

    return yield* pipe(HashMap.get(entries, fixture.url), Effect.fromOption, Effect.mapError(Function.constant(missingCredentials)))
  })

  const forget = (url: string) => pipe(store, Ref.update(HashMap.remove(url)), Function.constant)
  const remember = (url: string, stored: Credentials) => Ref.update(store, HashMap.set(url, stored))

  const prepare = Effect.fn("SupportAcceptance.fixture.prepare")(function* (scenario: Scenario, binding: string, artifacts: string) {
    yield* requireKnown(bindings, "fixture", scenario.fixture)
    yield* requireKnown(actors, "actor", binding)

    const generated = generatePassword()
    const password = Redacted.make(generated)
    const spec = ServerSpec.make({ application: "support-cases", entry: "examples/support-cases/main.ts", prefix: "support-cases-acceptance-", artifacts })
    const { url } = yield* serve(spec, serverEnvironment(password))

    yield* Effect.forEach(customers, seedEntity(url, "support_customers.create"))
    yield* Effect.forEach(agents, seedEntity(url, "support_agents.create"))

    const sentinel = yield* seedSentinel(url)
    const target = yield* seedTargetFor(url, scenario.fixture)
    const admin = yield* login(url, "admin", password)
    const account = HashMap.get(actorAccounts, binding)

    const actor = yield* Option.match(account, {
      onNone: Function.constant(Effect.succeedNone),
      onSome: loginActor(url, password),
    })

    const stored = Credentials.make({ password, admin, actor })
    const remembered = remember(url, stored)

    yield* Effect.acquireRelease(remembered, forget(url))

    const targetIds = pipe(target, Option.map(Struct.get("id")), Option.toArray)
    const tracked = Array.prepend(targetIds, sentinel.id)
    const prepared = fixtureFacts(sentinel, target)

    return PreparedFixture.make({ binding: scenario.fixture, url, actor: binding, facts: prepared, tracked })
  })

  const session = Effect.fn("SupportAcceptance.fixture.session")(function* (fixture: PreparedFixture) {
    const stored = yield* credentials(fixture)

    return stored.actor
  })

  const secrets = Effect.fn("SupportAcceptance.fixture.secrets")(function* (fixture: PreparedFixture) {
    const stored = yield* credentials(fixture)
    const actorTokens = Option.toArray(stored.actor)
    const issued = Array.prepend(actorTokens, stored.admin)

    return Array.prepend(issued, stored.password)
  })

  const probe = Effect.fn("SupportAcceptance.fixture.probe")(function* (fixture: PreparedFixture, target: ProbeTarget) {
    const stored = yield* credentials(fixture)
    const administrative = Equal.equals(target.probe, "audit-trail")
    const token = administrative ? Option.some(stored.admin) : Option.none()
    const actor = ProbeActorSchema.make(administrative ? "fixture-admin-probe" : "fixture-public-probe")
    const operation = yield* pipe(HashMap.get(probeOperations, target.probe), Effect.fromOption, Effect.mapError(describeFailure))
    const input = PayloadSchema.make({ caseId: target.subject })
    const at = yield* now
    const response = yield* call(fixture.url, operation, input, token)

    return ProbeRecord.make({ probe: target.probe, phase: target.phase, subject: target.subject, actor, at, status: response.status, result: response.result, error: response.error })
  })

  const direct = Effect.fn("SupportAcceptance.fixture.direct")(function* (fixture: PreparedFixture, candidate: Candidate) {
    const stored = yield* credentials(fixture)
    const at = yield* now
    const response = yield* call(fixture.url, candidate.operation, candidate.input, stored.actor)

    return Submission.make({ inputCase: candidate.inputCase, operation: candidate.operation, input: candidate.input, status: response.status, result: response.result, error: response.error, at })
  })

  return FixtureRuntime.of({ bindings, actors, facts, probes, prepare, probe, direct, session, secrets })
})

const runtimeEffect = runtime()

export const fixtureLayer = Layer.effect(FixtureRuntime, runtimeEffect)
