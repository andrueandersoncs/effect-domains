import { expect, it } from "@effect/vitest"
import { Array, Effect, Equivalence, Option, Order, Struct, pipe } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
import { Application } from "effect-domains/application"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { SchemaStore } from "effect-domains/migrations"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { ElectionsApplication } from "@effect-domains/example-community-elections/application"

import {
  AddCandidateInputSchema, AdvanceElectionInputSchema, BallotReceiptSchema, CandidateCountSchema, CandidateSchema,
  CreateElectionInputSchema, ElectionInputSchema, TallyRoundSchema, VoteInputSchema,
} from "@effect-domains/example-community-elections/domain"

import { ElectionsMigrations } from "@effect-domains/example-community-elections/migrations"
import { TestIdentity, sessionFor } from "./identity-fixture.ts"

const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: ElectionsMigrations })

const setup = Effect.fn("CommunityElections.setup")(function* () {
  const schemaStore = yield* SchemaStore

  yield* Application.prepare(ElectionsApplication, schemaStore)

  const client = yield* RpcTest.makeClient(ElectionsApplication.group)
  const sql = yield* SqlClient.SqlClient
  const alice = yield* sessionFor("alice")
  const bob = yield* sessionFor("bob")
  const admin = yield* sessionFor("admin")
  const outsider = yield* sessionFor("outsider")
  const create = CreateElectionInputSchema.make({ title: "Community garden coordinator" })
  const election = yield* client["election.create"](create, { headers: alice })
  const firstInput = AddCandidateInputSchema.make({ electionId: election.id, expectedVersion: 1, name: "A" })
  const first = yield* client["election.addCandidate"](firstInput, { headers: alice })
  const secondInput = AddCandidateInputSchema.make({ electionId: election.id, expectedVersion: first.election.version, name: "B" })
  const second = yield* client["election.addCandidate"](secondInput, { headers: alice })
  const thirdInput = AddCandidateInputSchema.make({ electionId: election.id, expectedVersion: second.election.version, name: "C" })
  const third = yield* client["election.addCandidate"](thirdInput, { headers: alice })

  const findNamed = (name: string) => {
    const isNamed = (candidate: typeof CandidateSchema.Type) => Equivalence.strictEqual<string>()(candidate.name, name)

    return pipe(third.candidates, Array.findFirst(isNamed), Option.getOrThrow)
  }

  const a = findNamed("A")
  const b = findNamed("B")
  const c = findNamed("C")

  return [client, sql, alice, bob, admin, outsider, third.election, a, b, c] as const
})()

const provideElection = <A, E>(effect: Effect.Effect<A, E, Effect.Services<typeof setup>>) => pipe(
  effect,
  Effect.provide(ElectionsApplication.handlers),
  Effect.provide(AuthorizationRpc.layer),
  Effect.provide(TestIdentity),
  Effect.provide(sqlite),
)

it.effect("keeps ranked ballots account-local and publishes only closed aggregate results", Effect.fn("CommunityElections.privacy")(function* () {
  const [client, , alice, bob, admin, outsider, election, a, b, c] = yield* setup
  const electionInput = ElectionInputSchema.make({ electionId: election.id })
  const deniedInput = CreateElectionInputSchema.make({ title: "Reader cannot administer" })
  const deniedCreate = yield* pipe(client["election.create"](deniedInput, { headers: bob }), Effect.flip)

  expect(deniedCreate._tag).toBe("Forbidden")

  const hidden = yield* pipe(client["election.slate"](electionInput, { headers: outsider }), Effect.flip)

  expect(hidden._tag).toBe("ElectionNotFound")

  const prematureInput = VoteInputSchema.make({ electionId: election.id, ranking: [a.id] })
  const prematureVote = yield* pipe(client["election.vote"](prematureInput, { headers: alice }), Effect.flip)

  expect(prematureVote._tag).toBe("ElectionNotOpen")
  expect(prematureVote).toMatchObject({ actual: "draft" })

  const advance = AdvanceElectionInputSchema.make({ electionId: election.id, expectedVersion: election.version })
  const opened = yield* client["election.open"](advance, { headers: alice })

  expect(opened).toMatchObject({ status: "open", version: 5 })

  const lateCandidate = AddCandidateInputSchema.make({ electionId: election.id, expectedVersion: opened.version, name: "Late candidate" })
  const frozen = yield* pipe(client["election.addCandidate"](lateCandidate, { headers: alice }), Effect.flip)

  expect(frozen._tag).toBe("ElectionNotDraft")

  const earlyResult = yield* pipe(client["election.result"](electionInput, { headers: bob }), Effect.flip)

  expect(earlyResult._tag).toBe("ElectionNotClosed")

  const aliceVote = VoteInputSchema.make({ electionId: election.id, ranking: [a.id, b.id] })

  yield* client["election.vote"](aliceVote, { headers: alice })

  const noOtherBallot = yield* pipe(client["election.myBallot"](electionInput, { headers: bob }), Effect.flip)

  expect(noOtherBallot._tag).toBe("BallotNotFound")

  const duplicateInput = VoteInputSchema.make({ electionId: election.id, ranking: [b.id, b.id] })
  const duplicate = yield* pipe(client["election.vote"](duplicateInput, { headers: alice }), Effect.flip)

  expect(duplicate._tag).toBe("InvalidRanking")
  expect(duplicate).toMatchObject({ reason: "duplicate" })

  const otherInput = CreateElectionInputSchema.make({ title: "Different slate" })
  const otherElection = yield* client["election.create"](otherInput, { headers: alice })
  const unknownInput = VoteInputSchema.make({ electionId: election.id, ranking: [otherElection.id] })
  const unknown = yield* pipe(client["election.vote"](unknownInput, { headers: alice }), Effect.flip)

  expect(unknown._tag).toBe("InvalidRanking")
  expect(unknown).toMatchObject({ reason: "unknownCandidate" })

  const unchanged = yield* client["election.myBallot"](electionInput, { headers: alice })
  const expectedBallot = BallotReceiptSchema.make(aliceVote)

  expect(unchanged).toEqual(expectedBallot)

  const bobVote = VoteInputSchema.make({ electionId: election.id, ranking: [b.id] })
  const closeInput = AdvanceElectionInputSchema.make({ electionId: election.id, expectedVersion: opened.version })

  yield* client["election.vote"](bobVote, { headers: bob })
  yield* client["election.vote"](prematureInput, { headers: admin })
  yield* client["election.close"](closeInput, { headers: alice })

  const result = yield* client["election.result"](electionInput, { headers: bob })

  expect(result.tally).toMatchObject({ outcome: "winner", winnerId: a.id, ballotCount: 3, tiedCandidateIds: [] })

  const aCount = CandidateCountSchema.make({ candidateId: a.id, votes: 2 })
  const bCount = CandidateCountSchema.make({ candidateId: b.id, votes: 1 })
  const cCount = CandidateCountSchema.make({ candidateId: c.id, votes: 0 })
  const counts = pipe([aCount, bCount, cCount], Array.sortWith(Struct.get("candidateId"), Order.String))
  const round = TallyRoundSchema.make({ counts, exhausted: 0, eliminated: null })

  expect(result.tally.rounds).toEqual([round])

  const lateVote = yield* pipe(client["election.vote"](bobVote, { headers: alice }), Effect.flip)

  expect(lateVote._tag).toBe("ElectionNotOpen")
  expect(lateVote).toMatchObject({ actual: "closed" })

  const closedBallot = yield* client["election.myBallot"](electionInput, { headers: alice })

  expect(closedBallot).toEqual(expectedBallot)
}, provideElection))

it.effect("rolls back a partially written replacement and a failed initial ballot", Effect.fn("CommunityElections.rollback")(function* () {
  const [client, sql, alice, bob, , , election, a, b, c] = yield* setup
  const electionInput = ElectionInputSchema.make({ electionId: election.id })
  const advance = AdvanceElectionInputSchema.make({ electionId: election.id, expectedVersion: election.version })
  const originalVote = VoteInputSchema.make({ electionId: election.id, ranking: [a.id, b.id] })

  yield* client["election.open"](advance, { headers: alice })
  yield* client["election.vote"](originalVote, { headers: alice })

  yield* sql`CREATE TRIGGER reject_second_preference BEFORE INSERT ON election_preferences WHEN NEW.rank = 2
    BEGIN SELECT RAISE(ABORT, 'preference storage unavailable'); END`

  const replacementInput = VoteInputSchema.make({ electionId: election.id, ranking: [c.id, a.id] })
  const replacement = yield* pipe(client["election.vote"](replacementInput, { headers: alice }), Effect.flip)

  expect(replacement._tag).toBe("ElectionsUnavailable")

  const restored = yield* client["election.myBallot"](electionInput, { headers: alice })
  const expectedOriginal = BallotReceiptSchema.make(originalVote)

  expect(restored).toEqual(expectedOriginal)

  const initialInput = VoteInputSchema.make({ electionId: election.id, ranking: [b.id, c.id] })
  const initial = yield* pipe(client["election.vote"](initialInput, { headers: bob }), Effect.flip)

  expect(initial._tag).toBe("ElectionsUnavailable")

  const absent = yield* pipe(client["election.myBallot"](electionInput, { headers: bob }), Effect.flip)

  expect(absent._tag).toBe("BallotNotFound")

  yield* sql`DROP TRIGGER reject_second_preference`

  const finalInput = VoteInputSchema.make({ electionId: election.id, ranking: [c.id] })

  yield* client["election.vote"](finalInput, { headers: alice })

  const finalBallot = yield* client["election.myBallot"](electionInput, { headers: alice })
  const expectedFinal = BallotReceiptSchema.make(finalInput)

  expect(finalBallot).toEqual(expectedFinal)
}, provideElection))

it.effect("guards slate version changes and leaves draft state intact when candidate insertion fails", Effect.fn("CommunityElections.slate")(function* () {
  const [client, sql, alice, , , , election] = yield* setup
  const staleInput = AddCandidateInputSchema.make({ electionId: election.id, expectedVersion: 1, name: "Stale candidate" })
  const stale = yield* pipe(client["election.addCandidate"](staleInput, { headers: alice }), Effect.flip)

  expect(stale._tag).toBe("VersionConflict")
  expect(stale).toMatchObject({ expectedVersion: 1 })

  yield* sql`CREATE TRIGGER reject_candidate BEFORE INSERT ON election_candidates
    BEGIN SELECT RAISE(ABORT, 'candidate storage unavailable'); END`

  const failedInput = AddCandidateInputSchema.make({ electionId: election.id, expectedVersion: election.version, name: "Rejected" })
  const failed = yield* pipe(client["election.addCandidate"](failedInput, { headers: alice }), Effect.flip)

  expect(failed._tag).toBe("ElectionsUnavailable")

  const electionInput = ElectionInputSchema.make({ electionId: election.id })
  const slate = yield* client["election.slate"](electionInput, { headers: alice })

  expect(slate).toMatchObject({
    election: { status: "draft", version: election.version }, candidates: [{ name: "A" }, { name: "B" }, { name: "C" }],
  })

  yield* sql`DROP TRIGGER reject_candidate`

  const emptyInput = CreateElectionInputSchema.make({ title: "Empty election" })
  const empty = yield* client["election.create"](emptyInput, { headers: alice })
  const invalidInput = AdvanceElectionInputSchema.make({ electionId: empty.id, expectedVersion: empty.version })
  const invalid = yield* pipe(client["election.open"](invalidInput, { headers: alice }), Effect.flip)

  expect(invalid._tag).toBe("InvalidSlate")
  expect(invalid).toMatchObject({ candidateCount: 0 })
}, provideElection))
