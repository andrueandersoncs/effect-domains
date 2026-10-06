import { Schema, pipe } from "effect"
import { NonNegativeSafeIntSchema, PositiveSafeIntSchema, UuidV7Schema } from "effect-domains/domain"

export const TenantIdSchema = pipe(Schema.NonEmptyString, Schema.brand("ElectionTenantId"))
export const ElectionStatusSchema = Schema.Literals(["draft", "open", "closed"])

export const ElectionSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  title: Schema.NonEmptyString,
  status: ElectionStatusSchema,
  version: PositiveSafeIntSchema,
})

export interface Election extends Schema.Schema.Type<typeof ElectionSchema> {}

export const CandidateSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  electionId: UuidV7Schema,
  name: Schema.NonEmptyString,
})

interface Candidate extends Schema.Schema.Type<typeof CandidateSchema> {}

export const BallotSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  electionId: UuidV7Schema,
  voterId: Schema.NonEmptyString,
})

interface Ballot extends Schema.Schema.Type<typeof BallotSchema> {}

export const PreferenceSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  electionId: UuidV7Schema,
  ballotId: UuidV7Schema,
  candidateId: UuidV7Schema,
  rank: pipe(PositiveSafeIntSchema, Schema.check(Schema.isLessThanOrEqualTo(20))),
})

interface Preference extends Schema.Schema.Type<typeof PreferenceSchema> {}

export const RankingSchema = pipe(
  Schema.Array(UuidV7Schema),
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20)),
)

export const CreateElectionInputSchema = Schema.Struct({ title: ElectionSchema.fields.title })

interface CreateElectionInput extends Schema.Schema.Type<typeof CreateElectionInputSchema> {}

export const ElectionInputSchema = Schema.Struct({ electionId: CandidateSchema.fields.electionId })

interface ElectionInput extends Schema.Schema.Type<typeof ElectionInputSchema> {}

export const AdvanceElectionInputSchema = Schema.Struct({
  ...ElectionInputSchema.fields,
  expectedVersion: ElectionSchema.fields.version,
})

interface AdvanceElectionInput extends Schema.Schema.Type<typeof AdvanceElectionInputSchema> {}

export const AddCandidateInputSchema = Schema.Struct({
  ...AdvanceElectionInputSchema.fields,
  name: CandidateSchema.fields.name,
})

interface AddCandidateInput extends Schema.Schema.Type<typeof AddCandidateInputSchema> {}

export const VoteInputSchema = Schema.Struct({ ...ElectionInputSchema.fields, ranking: RankingSchema })

interface VoteInput extends Schema.Schema.Type<typeof VoteInputSchema> {}

export const BallotReceiptSchema = Schema.Struct(VoteInputSchema.fields)

interface BallotReceipt extends Schema.Schema.Type<typeof BallotReceiptSchema> {}

export const CandidateCountSchema = Schema.Struct({
  candidateId: UuidV7Schema,
  votes: NonNegativeSafeIntSchema,
})

interface CandidateCount extends Schema.Schema.Type<typeof CandidateCountSchema> {}

export const TallyRoundSchema = Schema.Struct({
  counts: Schema.Array(CandidateCountSchema),
  exhausted: NonNegativeSafeIntSchema,
  eliminated: Schema.NullOr(UuidV7Schema),
})

export interface TallyRound extends Schema.Schema.Type<typeof TallyRoundSchema> {}

export const TallySchema = Schema.Struct({
  outcome: Schema.Literals(["winner", "tie", "noVotes"]),
  winnerId: Schema.NullOr(UuidV7Schema),
  tiedCandidateIds: Schema.Array(UuidV7Schema),
  ballotCount: NonNegativeSafeIntSchema,
  rounds: Schema.Array(TallyRoundSchema),
})

export interface Tally extends Schema.Schema.Type<typeof TallySchema> {}

export class ElectionNotFound extends Schema.TaggedError<ElectionNotFound>()(
  "ElectionNotFound", { electionId: UuidV7Schema },
) {}

export class ElectionNotDraft extends Schema.TaggedError<ElectionNotDraft>()(
  "ElectionNotDraft", { electionId: UuidV7Schema, actual: ElectionStatusSchema },
) {}

export class ElectionNotOpen extends Schema.TaggedError<ElectionNotOpen>()(
  "ElectionNotOpen", { electionId: UuidV7Schema, actual: ElectionStatusSchema },
) {}

export class ElectionNotClosed extends Schema.TaggedError<ElectionNotClosed>()(
  "ElectionNotClosed", { electionId: UuidV7Schema, actual: ElectionStatusSchema },
) {}

export class InvalidSlate extends Schema.TaggedError<InvalidSlate>()(
  "InvalidSlate", { electionId: UuidV7Schema, candidateCount: NonNegativeSafeIntSchema },
) {}

const InvalidRankingReasonSchema = Schema.Literals(["duplicate", "unknownCandidate"])

export class InvalidRanking extends Schema.TaggedError<InvalidRanking>()(
  "InvalidRanking", { electionId: UuidV7Schema, reason: InvalidRankingReasonSchema },
) {}

export class BallotNotFound extends Schema.TaggedError<BallotNotFound>()(
  "BallotNotFound", { electionId: UuidV7Schema },
) {}

export class ElectionsUnavailable extends Schema.TaggedError<ElectionsUnavailable>()(
  "ElectionsUnavailable", {},
) {}
