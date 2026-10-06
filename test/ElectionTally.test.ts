import { expect, it } from "@effect/vitest"
import { tally } from "@effect-domains/example-community-elections/tally"
import { Array, Effect, pipe } from "effect"
import { TallySchema } from "@effect-domains/example-community-elections/domain"

const A = "01900000-0000-7000-8000-000000000001"
const B = "01900000-0000-7000-8000-000000000002"
const C = "01900000-0000-7000-8000-000000000003"
const D = "01900000-0000-7000-8000-000000000004"

it.effect("transfers the unique minimum's ballots to elect a different first-round runner-up", Effect.fn("ElectionTally.transfer")(function* () {
  const result = yield* tally([A, B, C], [[A], [A], [A], [A], [B], [B], [B], [C, B], [C, B]])

  expect(result)
    .toEqual({
      outcome: "winner", winnerId: B, tiedCandidateIds: [], ballotCount: 9,
      rounds: [
        { counts: [{ candidateId: A, votes: 4 }, { candidateId: B, votes: 3 }, { candidateId: C, votes: 2 }], exhausted: 0, eliminated: C },
        { counts: [{ candidateId: A, votes: 4 }, { candidateId: B, votes: 5 }], exhausted: 0, eliminated: null },
      ],
    })
}))

it.effect("requires a strict majority and reports a final tie after transfer", Effect.fn("ElectionTally.majority")(function* () {
  const result = yield* tally([A, B, C], [[A], [A], [A], [B], [B], [C, B]])

  expect(result)
    .toEqual({
      outcome: "tie", winnerId: null, tiedCandidateIds: [A, B], ballotCount: 6,
      rounds: [
        { counts: [{ candidateId: A, votes: 3 }, { candidateId: B, votes: 2 }, { candidateId: C, votes: 1 }], exhausted: 0, eliminated: C },
        { counts: [{ candidateId: A, votes: 3 }, { candidateId: B, votes: 3 }], exhausted: 0, eliminated: null },
      ],
    })
}))

it.effect("excludes exhausted ballots from the majority denominator", Effect.fn("ElectionTally.exhaustion")(function* () {
  const result = yield* tally([A, B, C], [[A], [A], [A], [B], [B], [C]])

  expect(result)
    .toEqual({
      outcome: "winner", winnerId: A, tiedCandidateIds: [], ballotCount: 6,
      rounds: [
        { counts: [{ candidateId: A, votes: 3 }, { candidateId: B, votes: 2 }, { candidateId: C, votes: 1 }], exhausted: 0, eliminated: C },
        { counts: [{ candidateId: A, votes: 3 }, { candidateId: B, votes: 2 }], exhausted: 1, eliminated: null },
      ],
    })
}))

it.effect("stops at a tied elimination rather than inventing a finalist or tie-break", Effect.fn("ElectionTally.eliminationTie")(function* () {
  const result = yield* tally([A, B, C], [[A], [A], [A], [B, A], [B, A], [C, A], [C, A]])

  expect(result)
    .toEqual({
      outcome: "tie", winnerId: null, tiedCandidateIds: [B, C], ballotCount: 7,
      rounds: [{ counts: [{ candidateId: A, votes: 3 }, { candidateId: B, votes: 2 }, { candidateId: C, votes: 2 }], exhausted: 0, eliminated: null }],
    })
}))

it.effect("includes zero-vote candidates in elimination ties", Effect.fn("ElectionTally.zeroTie")(function* () {
  const result = yield* tally([D, B, C, A], [[A], [A], [B], [B]])

  expect(result)
    .toEqual({
      outcome: "tie", winnerId: null, tiedCandidateIds: [C, D], ballotCount: 4,
      rounds: [{ counts: [{ candidateId: A, votes: 2 }, { candidateId: B, votes: 2 }, { candidateId: C, votes: 0 }, { candidateId: D, votes: 0 }], exhausted: 0, eliminated: null }],
    })
}))

it.effect("returns no rounds for an empty election independently of earlier ballots", Effect.fn("ElectionTally.empty")(function* () {
  const result = yield* tally([A, B], [[B]])

  expect(result)
    .toEqual({
      outcome: "winner", winnerId: B, tiedCandidateIds: [], ballotCount: 1,
      rounds: [{ counts: [{ candidateId: A, votes: 0 }, { candidateId: B, votes: 1 }], exhausted: 0, eliminated: null }],
    })

  const empty = yield* tally([A, B], [])

  expect(empty)
    .toEqual({ outcome: "noVotes", winnerId: null, tiedCandidateIds: [], ballotCount: 0, rounds: [] })
}))

it.effect("is invariant under candidate and ballot ordering without mutating either input", Effect.fn("ElectionTally.order")(function* () {
  const candidates = Object.freeze([C, A, B])
  const freezeRanking = (ranking: ReadonlyArray<string>) => Object.freeze(ranking)

  const rankings = Array.map(
    [[A], [C, B], [B], [A], [B], [A]],
    freezeRanking,
  )

  const ballots = Object.freeze(rankings)

  const expected = TallySchema.make({
    outcome: "tie", winnerId: null, tiedCandidateIds: [A, B], ballotCount: 6,
    rounds: [
      { counts: [{ candidateId: A, votes: 3 }, { candidateId: B, votes: 2 }, { candidateId: C, votes: 1 }], exhausted: 0, eliminated: C },
      { counts: [{ candidateId: A, votes: 3 }, { candidateId: B, votes: 3 }], exhausted: 0, eliminated: null },
    ],
  })

  const original = yield* tally(candidates, ballots)
  const reversedCandidates = Array.reverse(candidates)
  const reversedBallots = Array.reverse(ballots)
  const reversed = yield* tally(reversedCandidates, reversedBallots)

  expect(original).toEqual(expected)
  expect(reversed).toEqual(expected)
  expect(candidates).toEqual([C, A, B])
  expect(ballots).toEqual([[A], [C, B], [B], [A], [B], [A]])
}))
