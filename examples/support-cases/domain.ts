import { Schema, identity, pipe } from "effect"
import { PositiveSafeIntSchema, identifier } from "effect-domains/domain"
import { Transitions } from "effect-domains/transitions"

export const SupportPartyIdSchema = pipe(Schema.NonEmptyString, identifier)
export const SupportCasePrioritySchema = Schema.Literals(["low", "normal", "high", "urgent"])
export const SupportCaseStatusSchema = Schema.Literals(["open", "triaged", "assigned", "resolved"])
export const SupportCaseVersionSchema = identity(PositiveSafeIntSchema)

export const SupportCaseTransitions = Transitions.make({
  name: "SupportCase",
  field: "status",
  status: SupportCaseStatusSchema,
  transitions: {
    triage: { from: ["open"], to: "triaged" },
    assign: { from: ["triaged"], to: "assigned" },
    resolve: { from: ["assigned"], to: "resolved" },
    reopen: { from: ["resolved"], to: "triaged" },
  },
})

export const SupportCustomerSchema = Schema.Struct({
  id: SupportPartyIdSchema,
  name: Schema.NonEmptyString,
})

interface SupportCustomer extends Schema.Schema.Type<typeof SupportCustomerSchema> {}

export const SupportAgentSchema = Schema.Struct({
  id: SupportPartyIdSchema,
  name: Schema.NonEmptyString,
  onDuty: Schema.Boolean,
})

interface SupportAgent extends Schema.Schema.Type<typeof SupportAgentSchema> {}

export const SupportCaseSchema = Schema.Struct({
  customerId: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
  priority: SupportCasePrioritySchema,
  status: SupportCaseStatusSchema,
  assignedAgentId: Schema.NullOr(Schema.NonEmptyString),
  openedAt: Schema.DateTimeUtc,
  version: SupportCaseVersionSchema,
})

interface SupportCase extends Schema.Schema.Type<typeof SupportCaseSchema> {}

export const SupportCaseEventKindSchema = Schema.Literals([
  "opened",
  "triaged",
  "assigned",
  "resolved",
  "reopened",
])

export const SupportCaseEventSchema = Schema.Struct({
  caseId: Schema.NonEmptyString,
  kind: SupportCaseEventKindSchema,
  agentId: Schema.NullOr(Schema.NonEmptyString),
  note: Schema.NullOr(Schema.NonEmptyString),
  occurredAt: Schema.DateTimeUtc,
})

interface SupportCaseEvent extends Schema.Schema.Type<typeof SupportCaseEventSchema> {}

export const OpenSupportCaseInputSchema = Schema.Struct({
  customerId: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
  priority: Schema.optionalKey(SupportCasePrioritySchema),
})

interface OpenSupportCaseInput extends Schema.Schema.Type<typeof OpenSupportCaseInputSchema> {}

export const AdvanceSupportCaseInputSchema = Schema.Struct({
  caseId: Schema.NonEmptyString,
  expectedVersion: SupportCaseVersionSchema,
  action: SupportCaseTransitions.actions,
  assignedAgentId: Schema.optionalKey(Schema.NonEmptyString),
  note: Schema.optionalKey(Schema.NonEmptyString),
})

interface AdvanceSupportCaseInput extends Schema.Schema.Type<typeof AdvanceSupportCaseInputSchema> {}

export const GetSupportCaseInputSchema = Schema.Struct({
  caseId: Schema.NonEmptyString,
})

interface GetSupportCaseInput extends Schema.Schema.Type<typeof GetSupportCaseInputSchema> {}

export class SupportCustomerNotFound extends Schema.TaggedError<SupportCustomerNotFound>()(
  "SupportCustomerNotFound",
  { customerId: Schema.String },
) {}

export class SupportAgentRequired extends Schema.TaggedError<SupportAgentRequired>()(
  "SupportAgentRequired",
  { caseId: Schema.String },
) {}

export class SupportAgentNotFound extends Schema.TaggedError<SupportAgentNotFound>()(
  "SupportAgentNotFound",
  { agentId: Schema.String },
) {}

export class AgentOffDuty extends Schema.TaggedError<AgentOffDuty>()(
  "AgentOffDuty",
  { agentId: Schema.String },
) {}

export class SupportCaseNotFound extends Schema.TaggedError<SupportCaseNotFound>()(
  "SupportCaseNotFound",
  { caseId: Schema.String },
) {}

export class SupportCasesUnavailable extends Schema.TaggedError<SupportCasesUnavailable>()(
  "SupportCasesUnavailable",
  {},
) {}
