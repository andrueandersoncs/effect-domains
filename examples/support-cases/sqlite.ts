import { Effect, Equivalence, Match, Option, Schema, pipe } from "effect"
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql"
import { Command } from "effect-domains/command"
import type { StructValue } from "effect-domains/domain"
import { ResourceNotFound, VersionConflict } from "effect-domains/repository-store"
import { Resource } from "effect-domains/resource"
import { ReadModel } from "effect-domains/read-model"
import { Table } from "effect-domains/table"
import { SupportCaseBoardList } from "./board.ts"
import { SupportCaseDetail } from "./contracts.ts"

import {
  appendSupportCaseAudit,
  SupportCaseAuditOperation,
  SupportCaseAuditsResource,
} from "./audit.ts"

import {
  AdvanceSupportCaseInputSchema,
  AgentOffDuty,
  GetSupportCaseInputSchema,
  OpenSupportCaseInputSchema,
  SupportAgentNotFound,
  SupportAgentRequired,
  SupportCaseNotFound,
  SupportCasesUnavailable,
  SupportCaseTransitions,
  SupportCustomerNotFound,
} from "./domain.ts"

import {
  SupportAgentsResource,
  SupportCaseEventsResource,
  SupportCasesResource,
  SupportCustomersResource,
} from "./resources.ts"


const supportCasesTable = Resource.table(SupportCasesResource)
const supportCustomersTable = Resource.table(SupportCustomersResource)
const supportAgentsTable = Resource.table(SupportAgentsResource)
const supportCaseEventsTable = Resource.table(SupportCaseEventsResource)

const SupportCaseProjection = Table.project(supportCasesTable, [
  "id",
  "customerId",
  "subject",
  "priority",
  "status",
  "assignedAgentId",
  "openedAt",
  "version",
])

const SupportCustomerProjection = Table.project(supportCustomersTable, ["id", "name"])
const SupportAgentProjection = Table.project(supportAgentsTable, ["id", "name", "onDuty"])

const SupportCaseEventProjection = Table.project(supportCaseEventsTable, [
  "id",
  "caseId",
  "kind",
  "agentId",
  "note",
  "occurredAt",
])

const SupportCaseDetailProjectionSchema = pipe(
  Schema.Struct({
    case: SupportCaseProjection.json,
    customer: SupportCustomerProjection.json,
    agent: Schema.NullOr(SupportAgentProjection.json),
    events: Schema.fromJsonString(Schema.Array(SupportCaseEventProjection.schema)),
  }),
  Schema.decodeTo(SupportCaseDetail),
)

// SAFETY: The asserted result type matches because the SQL projection and decoding schema define the same columns.
const supportCaseDetail = SqlSchema.findOneOption({
  Request: GetSupportCaseInputSchema,
  Result: SupportCaseDetailProjectionSchema,
  execute: Effect.fn("SupportCases.detailQuery")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<StructValue>`
      SELECT ${SupportCaseProjection.object(sql, "support_case")} AS ${sql("case")},
        ${SupportCustomerProjection.object(sql, "customer")} AS ${sql("customer")},
        (
          SELECT ${SupportAgentProjection.object(sql, "agent")}
          FROM ${sql(supportAgentsTable.name)} agent
          WHERE agent.${sql("id")} = support_case.${sql("assignedAgentId")}
          LIMIT 1
        ) AS ${sql("agent")},
        COALESCE((
          SELECT json_group_array(${SupportCaseEventProjection.object(sql, "event")})
          FROM (
            SELECT * FROM ${sql(supportCaseEventsTable.name)}
            WHERE ${sql("caseId")} = support_case.${sql("id")}
            ORDER BY ${sql("occurredAt")}, ${sql("id")}
          ) event
        ), '[]') AS ${sql("events")}
      FROM ${sql(supportCasesTable.name)} support_case
      INNER JOIN ${sql(supportCustomersTable.name)} customer
        ON customer.${sql("id")} = support_case.${sql("customerId")}
      WHERE support_case.${sql("id")} = ${input.caseId}
      LIMIT 1
    `
  }),
}) as (
  input: typeof GetSupportCaseInputSchema.Type,
) => Effect.Effect<
  Option.Option<typeof SupportCaseDetail.Type>,
  Schema.SchemaError | SqlError.SqlError,
  SqlClient.SqlClient
>

const requireResource = <
  Value,
  Failure,
  Requirements,
  Missing,
>(
  get: (id: string) => Effect.Effect<Value, ResourceNotFound | Failure, Requirements>,
  missing: (id: string) => Missing,
) => (id: string) => pipe(
  get(id),
  Effect.catchTag("ResourceNotFound", () => pipe(
    id,
    missing,
    Effect.fail,
  )),
)

const customerRepository = Resource.repository(SupportCustomersResource)
const agentRepository = Resource.repository(SupportAgentsResource)
const caseRepository = Resource.repository(SupportCasesResource)

const missingCustomer = (customerId: string) => SupportCustomerNotFound.make({ customerId })
const missingAgent = (agentId: string) => SupportAgentNotFound.make({ agentId })
const missingCase = (caseId: string) => SupportCaseNotFound.make({ caseId })

const requireCustomer = requireResource(customerRepository.get, missingCustomer)
const requireAgent = requireResource(agentRepository.get, missingAgent)
const requireCase = requireResource(caseRepository.get, missingCase)



const assignmentFor = Effect.fn("SupportCases.assignmentFor")(function* (
  input: typeof AdvanceSupportCaseInputSchema.Type,
) {
  const assigning = Equivalence.strictEqual<string>()(input.action, "assign")

  if (!assigning) return Option.none<string>()

  const agentId = yield* pipe(
    Option.fromNullishOr(input.assignedAgentId),
    Effect.fromOption(() => SupportAgentRequired.make({ caseId: input.caseId })),
  )

  const agent = yield* requireAgent(agentId)

  if (!agent.onDuty) return yield* AgentOffDuty.make({ agentId: agent.id })

  return Option.some(agent.id)
})

const SupportAssignmentChangesSchema = Schema.Struct({
  assignedAgentId: Schema.NullOr(Schema.NonEmptyString),
})


const eventKinds = {
  triage: "triaged",
  assign: "assigned",
  resolve: "resolved",
  reopen: "reopened",
} as const

const SupportCommand = Command.family("support.", SupportCasesUnavailable)
const SupportTransaction = SupportCommand.transactional()

const openCaseSpec = SupportTransaction.define({
  name: "openCase",
  payload: OpenSupportCaseInputSchema,
  success: supportCasesTable.rowSchema,
  errors: SupportCustomerNotFound,
  dependencies: [SupportCustomersResource, SupportCasesResource, SupportCaseEventsResource, SupportCaseAuditsResource],
})

const openCase = Command.implement(openCaseSpec, Effect.fn("SupportCases.openCase")(function* (
  input: typeof OpenSupportCaseInputSchema.Type,
) {
  yield* requireCustomer(input.customerId)

  const supportCase = yield* pipe(
    Option.fromNullishOr(input.priority),
    Option.match({
      onNone: () => Resource.repository(SupportCasesResource).create({
        customerId: input.customerId,
        subject: input.subject,
      }),
      onSome: (priority) => Resource.repository(SupportCasesResource).create({
        customerId: input.customerId,
        subject: input.subject,
        priority,
      }),
    }),
  )

  yield* Resource.repository(SupportCaseEventsResource).create({
    caseId: supportCase.id,
    kind: "opened",
  })


  yield* appendSupportCaseAudit({
    id: `support-case:${supportCase.id}:${supportCase.version}`,
    action: "open",
    actorId: "public-api",
    targetId: supportCase.id,
  })

  return supportCase
}))


const advanceCaseErrorsSchema = Schema.Union([
  SupportCaseNotFound,
  SupportAgentRequired,
  SupportAgentNotFound,
  AgentOffDuty,
  VersionConflict,
  SupportCaseTransitions.Error,
])

const advanceCaseSpec = SupportTransaction.define({
  name: "advanceCase",
  payload: AdvanceSupportCaseInputSchema,
  success: supportCasesTable.rowSchema,
  errors: advanceCaseErrorsSchema,
  dependencies: [SupportCasesResource, SupportAgentsResource, SupportCaseEventsResource, SupportCaseAuditsResource],
})

const advanceCase = Command.implement(advanceCaseSpec, Effect.fn("SupportCases.advanceCase")(function* (
  input: typeof AdvanceSupportCaseInputSchema.Type,
) {
  yield* requireCase(input.caseId)

  const assignment = yield* assignmentFor(input)

  const changes = pipe(
    Match.value(input.action),
    Match.when("assign", () => pipe(
      assignment,
      Option.map(
        (assignedAgentId) => SupportAssignmentChangesSchema.make({ assignedAgentId }),
      ),
    )),
    Match.when("reopen", () => pipe(
      SupportAssignmentChangesSchema.make({ assignedAgentId: null }),
      Option.some,
    )),
    Match.orElse(() => Option.none<typeof SupportAssignmentChangesSchema.Type>()),
  )

  const transitionChanges = Option.getOrUndefined(changes)

  const supportCase = yield* Resource.repository(SupportCasesResource).transition(
    input.caseId,
    input.action,
    transitionChanges,
    input.expectedVersion,
  )

  yield* pipe(
    Option.fromNullishOr(input.note),
    Option.match({
      onNone: () => Resource.repository(SupportCaseEventsResource).create({
        caseId: supportCase.id,
        kind: eventKinds[input.action],
        agentId: supportCase.assignedAgentId,
      }),
      onSome: (note) => Resource.repository(SupportCaseEventsResource).create({
        caseId: supportCase.id,
        kind: eventKinds[input.action],
        agentId: supportCase.assignedAgentId,
        note,
      }),
    }),
  )

  yield* appendSupportCaseAudit({
    id: `support-case:${supportCase.id}:${supportCase.version}`,
    action: input.action,
    actorId: "public-api",
    targetId: supportCase.id,
  })

  return supportCase
}))


const caseDetailSpec = SupportCommand.define({
  name: "caseDetail",
  payload: GetSupportCaseInputSchema,
  success: SupportCaseDetail,
  errors: SupportCaseNotFound,
  dependencies: [SupportCasesResource, SupportCustomersResource, SupportAgentsResource, SupportCaseEventsResource],
})

const caseDetail = Command.implement(caseDetailSpec, Effect.fn("SupportCases.caseDetail")(function* (
  input: typeof GetSupportCaseInputSchema.Type,
) {
  yield* requireCase(input.caseId)

  const detail = yield* supportCaseDetail(input)

  if (Option.isNone(detail)) {
    return yield* SupportCaseNotFound.make({ caseId: input.caseId })
  }

  return detail.value
}))


const caseBoard = ReadModel.publish({
  name: "support.board",
  unavailable: SupportCasesUnavailable,
  page: SupportCaseBoardList,
})

export const SupportCaseOperations = Command.bundle(
  openCase,
  advanceCase,
  caseDetail,
  caseBoard,
  SupportCaseAuditOperation,
)


