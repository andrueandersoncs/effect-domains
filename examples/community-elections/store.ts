import { Effect, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { Resource } from "effect-domains/resource"
import { RankingSchema, TenantIdSchema } from "./domain.ts"
import { BallotsResource, CandidatesResource, PreferencesResource } from "./resources.ts"

const candidatesTable = Resource.table(CandidatesResource)
const ballotsTable = Resource.table(BallotsResource)
const preferencesTable = Resource.table(PreferencesResource)
export const ScopeSchema = Schema.Struct({ tenantId: TenantIdSchema, electionId: Schema.String })

export interface Scope extends Schema.Schema.Type<typeof ScopeSchema> {}

export const VoterScopeSchema = Schema.Struct({ ...ScopeSchema.fields, voterId: Schema.NonEmptyString })

interface VoterScope extends Schema.Schema.Type<typeof VoterScopeSchema> {}

export const BallotScopeSchema = Schema.Struct({ ...ScopeSchema.fields, ballotId: Schema.String })

interface BallotScope extends Schema.Schema.Type<typeof BallotScopeSchema> {}

export const candidatesForElection = SqlSchema.findAll({
  Request: ScopeSchema,
  Result: candidatesTable.rowSchema,
  execute: Effect.fn("Elections.candidatesForElection")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<typeof candidatesTable.rowSchema.Encoded>`
      SELECT * FROM ${sql(candidatesTable.name)}
      WHERE tenantId = ${input.tenantId} AND electionId = ${input.electionId}
      ORDER BY name, id
    `
  }),
})

export const ballotForVoter = SqlSchema.findOneOption({
  Request: VoterScopeSchema,
  Result: ballotsTable.rowSchema,
  execute: Effect.fn("Elections.ballotForVoter")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<typeof ballotsTable.rowSchema.Encoded>`
      SELECT * FROM ${sql(ballotsTable.name)}
      WHERE tenantId = ${input.tenantId} AND electionId = ${input.electionId} AND voterId = ${input.voterId}
    `
  }),
})

export const preferencesForBallot = SqlSchema.findAll({
  Request: BallotScopeSchema,
  Result: preferencesTable.rowSchema,
  execute: Effect.fn("Elections.preferencesForBallot")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<typeof preferencesTable.rowSchema.Encoded>`
      SELECT * FROM ${sql(preferencesTable.name)}
      WHERE tenantId = ${input.tenantId} AND electionId = ${input.electionId} AND ballotId = ${input.ballotId}
      ORDER BY rank
    `
  }),
})

const StoredRankingSchema = Schema.Struct({ ranking: Schema.fromJsonString(RankingSchema) })

interface StoredRanking extends Schema.Schema.Type<typeof StoredRankingSchema> {}

export const rankingsForElection = SqlSchema.findAll({
  Request: ScopeSchema,
  Result: StoredRankingSchema,
  execute: Effect.fn("Elections.rankingsForElection")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<typeof StoredRankingSchema.Encoded>`
      SELECT (
        SELECT json_group_array(p.candidateId)
        FROM (
          SELECT candidateId FROM ${sql(preferencesTable.name)}
          WHERE tenantId = b.tenantId AND electionId = b.electionId AND ballotId = b.id
          ORDER BY rank
        ) p
      ) AS ranking
      FROM ${sql(ballotsTable.name)} b
      WHERE b.tenantId = ${input.tenantId} AND b.electionId = ${input.electionId}
      ORDER BY b.id
    `
  }),
})
