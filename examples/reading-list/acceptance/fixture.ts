import { Array, DateTime, Effect, Equal, Function, Layer, Number, Option, type Redacted, Schema, flow, pipe } from "effect"
import { join } from "node:path"
import { AcceptanceError, Candidate, FixtureRuntime, PayloadSchema, PreparedFixture, ProbeTarget, Scenario, Submission, type Payload } from "@effect-domains/acceptance/model"
import { ServerSpec, call, serve } from "@effect-domains/acceptance/server"
import { ReadingListBookSchema } from "../domain.ts"

const revision = "isolated-reading-list@2"

const createBinding = "isolated-reading-list"

const targetBinding = "isolated-reading-list-target"

const bindings = [createBinding, targetBinding]

const actors = ["public-reader"]

const probes = Array.empty<string>()

const facts = ["sentinel", "sentinel.id", "target", "target.id", "target.title", "target.author", "target.status", "target.format", "target.notes", "target.rating"]

const BookRowSchema = Schema.Struct({ id: Schema.NonEmptyString, ...ReadingListBookSchema.fields })

interface BookRow extends Schema.Schema.Type<typeof BookRowSchema> {}

class SeededBook extends Schema.Class<SeededBook>("SeededBook")({
  row: BookRowSchema,
  encoded: PayloadSchema,
}) {}

const ServerEnvironmentSchema = Schema.Record(Schema.String, Schema.String)

// The database lives in the private directory because a shared database would leak state between fixtures.
const serverEnvironment = (directory: string) => ServerEnvironmentSchema.make({ READING_LIST_DB: join(directory, "application.sqlite") })

const fixtureError = (message: string) => AcceptanceError.make({ boundary: "fixture", message })

const describeFailure = flow(String, fixtureError)

const withinSuccess = Number.between({ minimum: 200, maximum: 299 })

const failedMessage = (status: number) => `Fixture call books.create failed with HTTP ${String(status)}`

const anonymous = Option.none<never>()

const decodeRow = Schema.decodeUnknownEffect(BookRowSchema)

const decodePayload = Schema.decodeUnknownEffect(PayloadSchema)

const seedBook = Effect.fn("ReadingListAcceptance.fixture.seed")(function* (url: string, input: Payload) {
  const response = yield* call(url, "books.create", input, anonymous)
  const succeeded = withinSuccess(response.status)
  const failure = pipe(response.status, failedMessage, fixtureError)
  const result = yield* succeeded ? Effect.succeed(response.result) : Effect.fail(failure)
  const value = yield* pipe(result, Effect.fromOption, Effect.mapError(Function.constant(failure)))
  const row: BookRow = yield* pipe(value, decodeRow, Effect.mapError(describeFailure))
  const encoded = yield* pipe(value, decodePayload, Effect.mapError(describeFailure))

  return SeededBook.make({ row, encoded })
})

const sentinelInput = PayloadSchema.make({
  title: "Unrelated fixture — preserve me",
  author: "Fixture author",
  status: "reading",
  format: "hardcover",
  rating: 4,
  notes: "Sentinel revision 1",
})

const targetInput = PayloadSchema.make({
  title: "Target fixture — planned book",
  author: "Target author",
  status: "planned",
  format: "ebook",
  rating: 3,
  notes: "Keep this note",
})

const unknownMessage = (kind: string, name: string) => `Unknown ${kind} binding ${name}`

const requireKnown = (known: ReadonlyArray<string>, kind: string, name: string) => {
  const bound = Array.contains(known, name)
  const failure = pipe(unknownMessage(kind, name), fixtureError, Effect.fail)

  return bound ? Effect.void : failure
}

const FactsSchema = Schema.Record(Schema.String, Schema.Unknown)

type Facts = typeof FactsSchema.Type

const withTarget = (known: Facts) => (target: SeededBook) => FactsSchema.make({
  ...known,
  target: target.encoded,
  "target.id": target.row.id,
  "target.title": target.row.title,
  "target.author": target.row.author,
  "target.status": target.row.status,
  "target.format": target.row.format,
  "target.notes": target.row.notes,
  "target.rating": target.row.rating,
})

const fixtureFacts = (sentinel: SeededBook, target: Option.Option<SeededBook>) => {
  const known = FactsSchema.make({ sentinel: sentinel.encoded, "sentinel.id": sentinel.row.id })

  return Option.match(target, { onNone: Function.constant(known), onSome: withTarget(known) })
}

const seededId = (seeded: SeededBook) => seeded.row.id

const now = Effect.map(DateTime.now, DateTime.formatIso)

const spec = (artifacts: string) => ServerSpec.make({ application: "reading-list", entry: "examples/reading-list/main.ts", prefix: "reading-list-acceptance-", artifacts })

const prepare = Effect.fn("ReadingListAcceptance.fixture.prepare")(function* (scenario: Scenario, binding: string, artifacts: string) {
  yield* requireKnown(bindings, "fixture", scenario.fixture)
  yield* requireKnown(actors, "actor", binding)

  const served = spec(artifacts)
  const { url } = yield* serve(served, serverEnvironment)
  const sentinel = yield* seedBook(url, sentinelInput)
  const targeted = Equal.equals(scenario.fixture, targetBinding)
  const seededTarget = pipe(seedBook(url, targetInput), Effect.asSome)
  const target = yield* targeted ? seededTarget : Effect.succeedNone
  const targetIds = pipe(target, Option.map(seededId), Option.toArray)
  const tracked = Array.prepend(targetIds, sentinel.row.id)
  const prepared = fixtureFacts(sentinel, target)

  return PreparedFixture.make({ binding: scenario.fixture, revision, url, actor: binding, facts: prepared, tracked })
})

const unsupportedProbe = (target: ProbeTarget) => `The Reading List fixture implements no probes; ${target.probe} is unsupported`

const probe = (_fixture: PreparedFixture, target: ProbeTarget) => pipe(target, unsupportedProbe, fixtureError, Effect.fail)

const direct = Effect.fn("ReadingListAcceptance.fixture.direct")(function* (fixture: PreparedFixture, candidate: Candidate) {
  const at = yield* now
  const response = yield* call(fixture.url, candidate.operation, candidate.input, anonymous)

  return Submission.make({ inputCase: candidate.inputCase, operation: candidate.operation, input: candidate.input, status: response.status, result: response.result, error: response.error, at, exchange: Option.none(), feedback: Option.none() })
})

// The application is public because the slice grants every operation to anonymous readers, so no session or secret exists.
const session = Function.constant(Effect.succeedNone)

const retained = Array.empty<Redacted.Redacted<string>>()

const noSecrets = Effect.succeed(retained)

const secrets = Function.constant(noSecrets)

const runtime = FixtureRuntime.of({ revision, bindings, actors, facts, probes, prepare, probe, direct, session, secrets })

export const fixtureLayer = Layer.succeed(FixtureRuntime, runtime)
