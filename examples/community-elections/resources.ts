import { ExampleRoles, ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { Transitions } from "effect-domains/transitions"
import { BallotSchema, CandidateSchema, ElectionSchema, ElectionStatusSchema, PreferenceSchema } from "./domain.ts"

export const ElectionTransitions = Transitions.make({
  name: "Election",
  field: "status",
  status: ElectionStatusSchema,
  transitions: {
    open: { from: ["draft"], to: "open" },
    close: { from: ["open"], to: "closed" },
  },
})

const electionPolicy = Authorization.for({ resource: ElectionSchema, subject: ExampleSubjectSchema })
const electionScope = electionPolicy.sameAs("tenantId")

const electionAuthorization = electionPolicy.policy({
  scope: electionScope,
  allow: { read: ExampleRoles.reader, create: ExampleRoles.editor, patch: ExampleRoles.editor, transition: ExampleRoles.editor },
})

const electionGet = Resource.get()
const electionList = Resource.list({ filter: ["status"], order: [["title", "asc"]], limit: 25 })

export const ElectionsResource = Resource.define({
  name: "elections",
  schema: ElectionSchema,
  version: "version",
  transitions: ElectionTransitions,
  authorization: electionAuthorization,
  capabilities: [electionGet, electionList],
  relations: { unique: [{ fields: ["tenantId", "id"] }] },
})

const candidatePolicy = Authorization.for({ resource: CandidateSchema, subject: ExampleSubjectSchema })
const candidateScope = candidatePolicy.sameAs("tenantId")

const candidateAuthorization = candidatePolicy.policy({
  scope: candidateScope,
  allow: { read: ExampleRoles.reader, create: ExampleRoles.editor },
})

const candidateGet = Resource.get()
const candidateList = Resource.list({ filter: ["electionId"], order: [["name", "asc"]], limit: 20 })
const electionReference = Resource.reference(ElectionsResource, ["id"])

export const CandidatesResource = Resource.define({
  name: "election_candidates",
  schema: CandidateSchema,
  authorization: candidateAuthorization,
  capabilities: [candidateGet, candidateList],
  relations: {
    unique: [{ fields: ["tenantId", "electionId", "id"] }],
    foreignKeys: [{ fields: ["electionId"], references: electionReference, scope: ["tenantId"] }],
  },
})

const ballotPolicy = Authorization.for({ resource: BallotSchema, subject: ExampleSubjectSchema })
const ballotTenant = ballotPolicy.sameAs("tenantId")
const ballotOwner = ballotPolicy.eq(ballotPolicy.row.voterId, ballotPolicy.subject.userId)
const ownBallot = ballotPolicy.all(ballotTenant, ballotOwner)
const ballotAuthorization = ballotPolicy.policy({ scope: ownBallot, allow: { read: ExampleRoles.reader, create: ExampleRoles.reader } })

export const BallotsResource = Resource.define({
  name: "election_ballots",
  schema: BallotSchema,
  authorization: ballotAuthorization,
  capabilities: [],
  relations: {
    unique: [{ fields: ["tenantId", "electionId", "id"] }, { fields: ["tenantId", "electionId", "voterId"] }],
    foreignKeys: [{ fields: ["electionId"], references: electionReference, scope: ["tenantId"] }],
  },
})

const preferencePolicy = Authorization.for({ resource: PreferenceSchema, subject: ExampleSubjectSchema })
const preferenceScope = preferencePolicy.sameAs("tenantId")

const preferenceAuthorization = preferencePolicy.policy({
  scope: preferenceScope,
  allow: { read: ExampleRoles.reader, create: ExampleRoles.reader },
})

const ballotReference = Resource.reference(BallotsResource, ["id"])
const candidateReference = Resource.reference(CandidatesResource, ["id"])

export const PreferencesResource = Resource.define({
  name: "election_preferences",
  schema: PreferenceSchema,
  authorization: preferenceAuthorization,
  capabilities: [],
  relations: {
    unique: [{ fields: ["ballotId", "rank"] }, { fields: ["ballotId", "candidateId"] }],
    foreignKeys: [
      { fields: ["ballotId"], references: ballotReference, scope: ["tenantId", "electionId"] },
      { fields: ["candidateId"], references: candidateReference, scope: ["tenantId", "electionId"] },
    ],
  },
})
