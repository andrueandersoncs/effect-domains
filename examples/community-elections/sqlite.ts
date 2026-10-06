import { Array, Effect, Equivalence, HashSet, Option, Predicate, Schema, Struct, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ExampleRoles, ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { Command } from "effect-domains/command"
import { VersionConflict } from "effect-domains/repository-store"
import { Resource } from "effect-domains/resource"
import { ElectionResultSchema, SlateSchema } from "./contracts.ts"

import {
  AddCandidateInputSchema, AdvanceElectionInputSchema, BallotNotFound, BallotReceiptSchema,
  CreateElectionInputSchema, ElectionInputSchema, ElectionNotClosed, ElectionNotDraft,
  ElectionNotFound, ElectionNotOpen, ElectionsUnavailable, ElectionStatusSchema, InvalidRanking, InvalidSlate,
  RankingSchema, TenantIdSchema, VoteInputSchema,
} from "./domain.ts"

import { BallotsResource, CandidatesResource, ElectionsResource, ElectionTransitions, PreferencesResource } from "./resources.ts"
import { BallotScopeSchema, ScopeSchema, VoterScopeSchema, ballotForVoter, candidatesForElection, preferencesForBallot, rankingsForElection } from "./store.ts"
import { tally } from "./tally.ts"

const electionsTable = Resource.table(ElectionsResource)
const preferencesTable = Resource.table(PreferencesResource)
const EditorCommand = Command.family("election.", ElectionsUnavailable).authorized(ExampleRoles.editor).transactional()
const VoterCommand = Command.family("election.", ElectionsUnavailable).authorized(ExampleRoles.reader).transactional()
const sameStatus = Equivalence.strictEqual<typeof ElectionStatusSchema.Type>()

const requireElection = Effect.fn("Elections.requireElection")(function* (electionId: string) {
  return yield* pipe(
    Resource.repository(ElectionsResource).get(electionId),
    Effect.catchTag("ResourceNotFound", () => ElectionNotFound.make({ electionId })),
  )
})

const loadSlate = Effect.fn("Elections.loadSlate")(function* (electionId: string) {
  const election = yield* requireElection(electionId)
  const scope = ScopeSchema.make({ tenantId: election.tenantId, electionId })
  const candidates = yield* candidatesForElection(scope)

  return SlateSchema.make({ election, candidates })
})

const createSpec = EditorCommand.define({
  name: "create", payload: CreateElectionInputSchema, success: electionsTable.rowSchema,
  errors: Schema.Never, dependencies: [ElectionsResource],
})

const create = Command.implement(createSpec, Effect.fn("Elections.create")(function* (
  input: typeof CreateElectionInputSchema.Type, subject: typeof ExampleSubjectSchema.Type,
) {
  const tenantId = TenantIdSchema.make(subject.tenantId)

  return yield* Resource.repository(ElectionsResource).create({ tenantId, title: input.title, status: "draft" })
}))

const AddCandidateErrorsSchema = Schema.Union([ElectionNotFound, ElectionNotDraft, InvalidSlate, VersionConflict])

const addCandidateSpec = EditorCommand.define({
  name: "addCandidate", payload: AddCandidateInputSchema, success: SlateSchema,
  errors: AddCandidateErrorsSchema,
  dependencies: [ElectionsResource, CandidatesResource],
})

const addCandidate = Command.implement(addCandidateSpec, Effect.fn("Elections.addCandidate")(function* (
  input: typeof AddCandidateInputSchema.Type,
) {
  const current = yield* loadSlate(input.electionId)

  if (!sameStatus(current.election.status, "draft")) {
    return yield* ElectionNotDraft.make({ electionId: input.electionId, actual: current.election.status })
  }

  if (current.candidates.length >= 20) {
    return yield* InvalidSlate.make({ electionId: input.electionId, candidateCount: current.candidates.length })
  }

  const sql = yield* SqlClient.SqlClient

  const updated = yield* sql<{ id: string }>`
    UPDATE ${sql(electionsTable.name)} SET version = version + 1
    WHERE id = ${input.electionId} AND tenantId = ${current.election.tenantId} AND version = ${input.expectedVersion}
    RETURNING id
  `

  if (updated.length < 1) {
    return yield* VersionConflict.make({ resource: electionsTable.name, key: input.electionId, expectedVersion: input.expectedVersion })
  }

  yield* Resource.repository(CandidatesResource).create({
    tenantId: current.election.tenantId, electionId: input.electionId, name: input.name,
  })

  return yield* loadSlate(input.electionId)
}))

const OpenErrorsSchema = Schema.Union([ElectionNotFound, InvalidSlate, VersionConflict, ElectionTransitions.Error])

const openSpec = EditorCommand.define({
  name: "open", payload: AdvanceElectionInputSchema, success: electionsTable.rowSchema,
  errors: OpenErrorsSchema,
  dependencies: [ElectionsResource, CandidatesResource],
})

const open = Command.implement(openSpec, Effect.fn("Elections.open")(function* (input: typeof AdvanceElectionInputSchema.Type) {
  const current = yield* loadSlate(input.electionId)
  const invalidSlate = current.candidates.length < 2 || current.candidates.length > 20

  if (invalidSlate) {
    return yield* InvalidSlate.make({ electionId: input.electionId, candidateCount: current.candidates.length })
  }

  return yield* Resource.repository(ElectionsResource).transition(input.electionId, "open", undefined, input.expectedVersion)
}))

const CloseErrorsSchema = Schema.Union([ElectionNotFound, VersionConflict, ElectionTransitions.Error])

const closeSpec = EditorCommand.define({
  name: "close", payload: AdvanceElectionInputSchema, success: electionsTable.rowSchema,
  errors: CloseErrorsSchema, dependencies: [ElectionsResource],
})

const close = Command.implement(closeSpec, Effect.fn("Elections.close")(function* (input: typeof AdvanceElectionInputSchema.Type) {
  yield* requireElection(input.electionId)

  return yield* Resource.repository(ElectionsResource).transition(input.electionId, "close", undefined, input.expectedVersion)
}))

const slateSpec = VoterCommand.define({
  name: "slate", payload: ElectionInputSchema, success: SlateSchema, errors: ElectionNotFound,
  dependencies: [ElectionsResource, CandidatesResource],
})

const slate = Command.implement(slateSpec, Effect.fn("Elections.slate")(function* (input: typeof ElectionInputSchema.Type) {
  return yield* loadSlate(input.electionId)
}))

const VoteErrorsSchema = Schema.Union([ElectionNotFound, ElectionNotOpen, InvalidRanking])

const voteSpec = VoterCommand.define({
  name: "vote", payload: VoteInputSchema, success: BallotReceiptSchema,
  errors: VoteErrorsSchema,
  dependencies: [ElectionsResource, CandidatesResource, BallotsResource, PreferencesResource],
})

const vote = Command.implement(voteSpec, Effect.fn("Elections.vote")(function* (
  input: typeof VoteInputSchema.Type, subject: typeof ExampleSubjectSchema.Type,
) {
  const current = yield* loadSlate(input.electionId)

  if (!sameStatus(current.election.status, "open")) {
    return yield* ElectionNotOpen.make({ electionId: input.electionId, actual: current.election.status })
  }

  const unique = HashSet.fromIterable(input.ranking)
  const uniqueCount = HashSet.size(unique)

  if (uniqueCount < input.ranking.length) {
    return yield* InvalidRanking.make({ electionId: input.electionId, reason: "duplicate" })
  }

  const registered = pipe(current.candidates, Array.map(Struct.get("id")), HashSet.fromIterable)
  const isUnknownCandidate = (candidateId: string) => !HashSet.has(registered, candidateId)
  const unknownCandidate = Array.some(input.ranking, isUnknownCandidate)

  if (unknownCandidate) {
    return yield* InvalidRanking.make({ electionId: input.electionId, reason: "unknownCandidate" })
  }

  const scope = VoterScopeSchema.make({ tenantId: current.election.tenantId, electionId: input.electionId, voterId: subject.userId })
  const existing = yield* ballotForVoter(scope)

  const ballot = yield* pipe(existing, Option.match({
    onSome: Effect.succeed,
    onNone: () => Resource.repository(BallotsResource).create(scope),
  }))

  const sql = yield* SqlClient.SqlClient

  yield* sql`DELETE FROM ${sql(preferencesTable.name)}
    WHERE tenantId = ${scope.tenantId} AND electionId = ${scope.electionId} AND ballotId = ${ballot.id}`

  yield* Effect.forEach(input.ranking, (candidateId, index) => Resource.repository(PreferencesResource).create({
    tenantId: scope.tenantId, electionId: scope.electionId, ballotId: ballot.id, candidateId, rank: index + 1,
  }), { discard: true })

  return BallotReceiptSchema.make(input)
}))

const MyBallotErrorsSchema = Schema.Union([ElectionNotFound, BallotNotFound])

const myBallotSpec = VoterCommand.define({
  name: "myBallot", payload: ElectionInputSchema, success: BallotReceiptSchema,
  errors: MyBallotErrorsSchema, dependencies: [ElectionsResource, BallotsResource, PreferencesResource],
})

const myBallot = Command.implement(myBallotSpec, Effect.fn("Elections.myBallot")(function* (
  input: typeof ElectionInputSchema.Type, subject: typeof ExampleSubjectSchema.Type,
) {
  const election = yield* requireElection(input.electionId)
  const scope = VoterScopeSchema.make({ tenantId: election.tenantId, electionId: input.electionId, voterId: subject.userId })
  const ballot = yield* ballotForVoter(scope)

  if (Option.isNone(ballot)) return yield* BallotNotFound.make({ electionId: input.electionId })

  const ballotScope = BallotScopeSchema.make({ ...scope, ballotId: ballot.value.id })
  const preferences = yield* preferencesForBallot(ballotScope)
  const ranking = yield* pipe(preferences, Array.map(Struct.get("candidateId")), Schema.decodeUnknownEffect(RankingSchema))

  return BallotReceiptSchema.make({ electionId: input.electionId, ranking })
}))

const ResultErrorsSchema = Schema.Union([ElectionNotFound, ElectionNotClosed])

const resultSpec = VoterCommand.define({
  name: "result", payload: ElectionInputSchema, success: ElectionResultSchema,
  errors: ResultErrorsSchema,
  dependencies: [ElectionsResource, CandidatesResource, BallotsResource, PreferencesResource],
})

const result = Command.implement(resultSpec, Effect.fn("Elections.result")(function* (input: typeof ElectionInputSchema.Type) {
  const current = yield* loadSlate(input.electionId)

  if (!sameStatus(current.election.status, "closed")) {
    return yield* ElectionNotClosed.make({ electionId: input.electionId, actual: current.election.status })
  }

  const scope = ScopeSchema.make({ tenantId: current.election.tenantId, electionId: input.electionId })
  const stored = yield* rankingsForElection(scope)
  const candidateIds = Array.map(current.candidates, Struct.get("id"))
  const ballots = Array.map(stored, Struct.get("ranking"))
  const counted = yield* tally(candidateIds, ballots)

  return ElectionResultSchema.make({ ...current, tally: counted })
}))

export const ElectionOperations = Command.bundle(create, addCandidate, open, close, slate, vote, myBallot, result)
