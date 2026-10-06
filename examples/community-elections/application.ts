import { Effect, pipe } from "effect"
import { Application, Part } from "effect-domains/application"
import { IdentityBundle } from "effect-domains/identity-rpc"
import { BallotsResource, CandidatesResource, ElectionsResource, PreferencesResource } from "./resources.ts"
import { ElectionOperations } from "./sqlite.ts"

const elections = Part.resource(ElectionsResource)
const candidates = Part.resource(CandidatesResource)
const ballots = Part.resource(BallotsResource)
const preferences = Part.resource(PreferencesResource)
const operations = Part.command(ElectionOperations)
const identity = Part.native(IdentityBundle)

const application = Application.define({
  name: "community-elections",
  parts: [elections, candidates, ballots, preferences, operations, identity],
})

export const ElectionsApplication = pipe(Application.compile(application), Effect.runSync)
