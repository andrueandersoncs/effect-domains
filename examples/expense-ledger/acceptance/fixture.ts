import { Array, DateTime, Effect, Function, Layer, Number, Option, Schema, flow, pipe } from "effect"
import { join } from "node:path"
import { AcceptanceError, Candidate, FixtureRuntime, PayloadSchema, PreparedFixture, ProbeTarget, Scenario, Submission, type Payload } from "@effect-domains/acceptance/model"
import { type Secret, ServerSpec, call, serve } from "@effect-domains/acceptance/server"

const binding = "expense-period"

const bindings = [binding]

const actors = ["public-bookkeeper"]

const probes = Array.empty<string>()

const periodStart = "2026-09-01"

const periodEnd = "2026-09-02"

const facts = ["period.from", "period.through"]

const ExpenseRowSchema = Schema.Struct({ id: Schema.NonEmptyString })

interface ExpenseRow extends Schema.Schema.Type<typeof ExpenseRowSchema> {}

const ServerEnvironmentSchema = Schema.Record(Schema.String, Schema.String)

// The ledger database lives in the private directory because a shared database would leak expenses between fixtures.
const serverEnvironment = (directory: string) => ServerEnvironmentSchema.make({ EXPENSE_LEDGER_DB: join(directory, "application.sqlite") })

const fixtureError = (message: string) => AcceptanceError.make({ boundary: "fixture", message })

const describeFailure = flow(String, fixtureError)

const withinSuccess = Number.between({ minimum: 200, maximum: 299 })

const failedMessage = (status: number) => `Fixture call expenses.record failed with HTTP ${String(status)}`

const anonymous = Option.none<never>()

const decodeRow = Schema.decodeUnknownEffect(ExpenseRowSchema)

const recordExpense = Effect.fn("ExpenseLedgerAcceptance.fixture.record")(function* (url: string, input: Payload) {
  const response = yield* call(url, "expenses.record", input, anonymous)
  const succeeded = withinSuccess(response.status)
  const failure = pipe(response.status, failedMessage, fixtureError)
  const result = yield* succeeded ? Effect.succeed(response.result) : Effect.fail(failure)
  const value = yield* pipe(result, Effect.fromOption, Effect.mapError(Function.constant(failure)))
  const row: ExpenseRow = yield* pipe(value, decodeRow, Effect.mapError(describeFailure))

  return row.id
})

// The period's two expenses differ in currency because totals group by category and currency, so both groups must survive every refusal.
const seededExpenses = [
  PayloadSchema.make({ date: periodStart, merchant: "Railway Cafe", category: "meals", amountMinor: 1875, currency: "USD" }),
  PayloadSchema.make({ date: periodEnd, merchant: "Station Bistro", category: "meals", amountMinor: 1600, currency: "EUR" }),
]

const unknownMessage = (kind: string, name: string) => `Unknown ${kind} binding ${name}`

const requireKnown = (known: ReadonlyArray<string>, kind: string, name: string) => {
  const bound = Array.contains(known, name)
  const failure = pipe(unknownMessage(kind, name), fixtureError, Effect.fail)

  return bound ? Effect.void : failure
}

const periodFacts = PayloadSchema.make({ "period.from": periodStart, "period.through": periodEnd })

const now = Effect.map(DateTime.now, DateTime.formatIso)

const spec = (artifacts: string) => ServerSpec.make({ application: "expense-ledger", entry: "examples/expense-ledger/main.ts", prefix: "expense-ledger-acceptance-", artifacts })

const prepare = Effect.fn("ExpenseLedgerAcceptance.fixture.prepare")(function* (scenario: Scenario, actor: string, artifacts: string) {
  yield* requireKnown(bindings, "fixture", scenario.fixture)
  yield* requireKnown(actors, "actor", actor)

  const served = spec(artifacts)
  const { url } = yield* serve(served, serverEnvironment)
  const tracked = yield* Effect.forEach(seededExpenses, (input) => recordExpense(url, input))

  return PreparedFixture.make({ binding: scenario.fixture, url, actor, facts: periodFacts, tracked })
})

const unsupportedProbe = (target: ProbeTarget) => `The Expense Ledger fixture implements no probes; ${target.probe} is unsupported`

const probe = (_fixture: PreparedFixture, target: ProbeTarget) => pipe(target, unsupportedProbe, fixtureError, Effect.fail)

const direct = Effect.fn("ExpenseLedgerAcceptance.fixture.direct")(function* (fixture: PreparedFixture, candidate: Candidate) {
  const at = yield* now
  const response = yield* call(fixture.url, candidate.operation, candidate.input, anonymous)

  return Submission.make({ inputCase: candidate.inputCase, operation: candidate.operation, input: candidate.input, status: response.status, result: response.result, error: response.error, at })
})

// The ledger is public because every expense operation is granted to anonymous callers, so no session or secret exists.
const session = Function.constant(Effect.succeedNone)

const retained = Array.empty<Secret>()

const noSecrets = Effect.succeed(retained)

const secrets = Function.constant(noSecrets)

const runtime = FixtureRuntime.of({ bindings, actors, facts, probes, prepare, probe, direct, session, secrets })

export const fixtureLayer = Layer.succeed(FixtureRuntime, runtime)
