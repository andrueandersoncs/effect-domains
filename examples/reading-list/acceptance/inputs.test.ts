import { expect, it } from "@effect/vitest"
import { Array, Context, Effect, Equal, Function, Option, Record, Schema, Struct, flow, pipe } from "effect"
import { inputLayer } from "@effect-domains/acceptance/inputs"
import { type Candidate, Catalog, InputCandidates, PreparedFixture, type Payload, type Scenario } from "@effect-domains/acceptance/model"
import { ReadingListApplication } from "../application.ts"
import { BookFormatSchema, ReadingStatusSchema } from "../domain.ts"
import { readingListCatalog } from "./catalog.ts"

const seed = 20261010

const isStatus = Schema.is(ReadingStatusSchema)

const isFormat = Schema.is(BookFormatSchema)

const sentinel: Payload = {
  id: "01890a5d-ac96-774b-bcce-b302099a8056",
  title: "Unrelated fixture — preserve me",
  author: "Fixture author",
  status: "reading",
  format: "hardcover",
  rating: 4,
  notes: "Sentinel revision 1",
}

const target: Payload = {
  id: "01890a5d-ac96-774b-bcce-b302099a8057",
  title: "A fixture title",
  author: "A fixture author",
  status: "planned",
  format: "ebook",
  rating: 3,
  notes: "Preserve this fixture note",
}

const freshTarget: Payload = {
  id: "01890a5d-ac96-7c4b-8cce-b302099a8058",
  title: "A fresh fixture title",
  author: "A fresh fixture author",
  status: "planned",
  format: "audiobook",
  rating: null,
  notes: null,
}

const targetFacts = (row: Payload): Payload => ({
  sentinel,
  "sentinel.id": sentinel.id,
  target: row,
  "target.id": row.id,
  "target.title": row.title,
  "target.author": row.author,
  "target.status": row.status,
  "target.format": row.format,
  "target.notes": row.notes,
  "target.rating": row.rating,
})

const createFacts: Payload = { sentinel, "sentinel.id": sentinel.id }

const fixtureWith = (binding: string) => (facts: Payload) => PreparedFixture.make({
  binding,
  url: "http://127.0.0.1/",
  actor: "public-reader",
  facts,
  tracked: [],
})

const createFixture = fixtureWith("isolated-reading-list")(createFacts)

const targetFixtureOf = flow(targetFacts, fixtureWith("isolated-reading-list-target"))

const targetFixture = targetFixtureOf(target)

const freshFixture = targetFixtureOf(freshTarget)

const decodedCatalog = Schema.decodeUnknownEffect(Catalog)(readingListCatalog)

const withId = (id: string) => (scenario: Scenario) => Equal.equals(scenario.id, id)

const resolvedFor = (fixture: PreparedFixture) => Effect.fn("ReadingListInputsTest.resolved")(function* (id: string) {
  const inputs = yield* InputCandidates
  const catalog = yield* decodedCatalog
  const scenario = yield* pipe(catalog.scenarios, Array.findFirst(withId(id)), Effect.fromOption)
  const candidates = yield* inputs.resolve(scenario, fixture, [], seed)

  return yield* pipe(candidates, Array.head, Effect.fromOption)
})

const ratingOf = (candidate: Candidate) => Record.get(candidate.input, "rating")

const withoutRating = (candidate: Candidate) => Record.remove(candidate.input, "rating")

const targetWithoutRating = Record.remove(target, "rating")

const expectedValidRatings = Array.map([1, 5, null], Option.some)

const expectedInvalidRatings = Array.map([0, 6, 1.5], Option.some)

const ratingStrategiesTest = Effect.gen(function* () {
  const resolve = resolvedFor(targetFixture)
  const valid = yield* Effect.forEach(["rating-minimum", "rating-maximum", "rating-null"], resolve)
  const invalid = yield* Effect.forEach(["rating-below", "rating-above", "rating-fractional"], resolve)
  const validRatings = Array.map(valid, ratingOf)
  const invalidRatings = Array.map(invalid, ratingOf)
  const validities = Array.map([...valid, ...invalid], Struct.get("validity"))
  const retained = Array.map([...valid, ...invalid], withoutRating)
  const expectedRetained = Array.replicate(targetWithoutRating, 6)
  const valids = Array.replicate("native-valid", 3)
  const invalids = Array.replicate("native-invalid", 3)
  const minimum = yield* pipe(valid, Array.head, Effect.fromOption)
  const above = yield* pipe(invalid, Array.get(1), Effect.fromOption)

  expect(validRatings).toEqual(expectedValidRatings)
  expect(invalidRatings).toEqual(expectedInvalidRatings)
  expect(validities).toEqual([...valids, ...invalids])
  expect(retained).toEqual(expectedRetained)
  expect(minimum.nativeValidation).toMatch(/^accepted by the exact native books\.update codec/)
  expect(above.nativeValidation).toMatch(/^rejected by the exact native books\.update codec: /)
  expect(above.input).toEqual({ ...target, rating: 6 })
})

const hasRating = (candidate: Candidate) => Record.has(candidate.input, "rating")

const hasIdentity = (candidate: Candidate) => Record.has(candidate.input, "id")

const createCandidatesTest = Effect.gen(function* () {
  const resolve = resolvedFor(createFixture)
  const sampled = yield* resolve("create-sample")
  const nulled = yield* resolve("create-null")
  const omitted = yield* resolve("create-omitted")
  const created = [sampled, nulled, omitted]
  const identities = Array.map(created, hasIdentity)
  const titles = Array.map(created, flow(Struct.get("input"), Struct.get("title")))
  const authors = Array.map(created, flow(Struct.get("input"), Struct.get("author")))
  const statuses = Array.map(created, flow(Struct.get("input"), Struct.get("status"), isStatus))
  const formats = Array.map(created, flow(Struct.get("input"), Struct.get("format"), isFormat))
  const validities = Array.map(created, Struct.get("validity"))
  const ratings = Array.map(created, hasRating)
  const nullRating = ratingOf(nulled)
  const omittedKeys = Record.keys(omitted.input)
  const expectedTitles = Array.replicate("The Dispossessed", 3)
  const expectedAuthors = Array.replicate("Ursula K. Le Guin", 3)
  const expectedValidities = Array.replicate("native-valid", 3)
  const expectedNull = Option.some(null)

  expect(identities).toEqual([false, false, false])
  expect(titles).toEqual(expectedTitles)
  expect(authors).toEqual(expectedAuthors)
  expect(statuses).toEqual([true, true, true])
  expect(formats).toEqual([true, true, true])
  expect(validities).toEqual(expectedValidities)
  expect(ratings).toEqual([true, true, false])
  expect(nullRating).toEqual(expectedNull)
  expect(omittedKeys).toEqual(["title", "author", "status", "format", "notes"])
})

const replayTest = Effect.gen(function* () {
  const inputs = yield* InputCandidates
  const catalog = yield* decodedCatalog
  const scenario = yield* pipe(catalog.scenarios, Array.findFirst(withId("rating-above")), Effect.fromOption)
  const recorded = yield* resolvedFor(targetFixture)("rating-above")
  const replayed = yield* inputs.replay(scenario, [recorded], freshFixture, [])
  const candidate = yield* pipe(replayed, Array.head, Effect.fromOption)

  expect(candidate.input).toEqual({ ...freshTarget, rating: 6 })
  expect(candidate.validity).toBe("native-invalid")
})

const codecServices = Context.empty()

const readingListInputs = inputLayer(ReadingListApplication, codecServices)

const provided = <A, E>(test: Effect.Effect<A, E, InputCandidates>) => Effect.provide(test, readingListInputs)

const ratingStrategies = provided(ratingStrategiesTest)

const createCandidates = provided(createCandidatesTest)

const replay = provided(replayTest)

it.effect("rating bounds and null resolve native-valid while below, above, and fractional stay raw and native-invalid", Function.constant(ratingStrategies))

it.effect("create candidates carry literal text and native values, never an identity, and omission drops the rating", Function.constant(createCandidates))

it.effect("rating replay rebinds fixture facts and keeps the recorded native value", Function.constant(replay))
