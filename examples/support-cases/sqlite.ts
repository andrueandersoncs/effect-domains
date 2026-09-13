import { Effect, Equivalence, Match, Option, Schema, pipe } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { Operation } from "effect-domains/operation"
import { VersionConflict } from "effect-domains/repository-store"
import { SqliteView } from "effect-domains/sqlite-view"
import { Table } from "effect-domains/table"
import { SupportCaseBoardList } from "./board.ts"
import { SupportCaseDetail } from "./contracts.ts"

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

type SqliteRow = Readonly<Record<string, unknown>>

const SupportCaseProjection = Table.project(SupportCasesResource.table, [
  "id",
  "customerId",
  "subject",
  "priority",
  "status",
  "assignedAgentId",
  "openedAt",
  "version",
])

const SupportCustomerProjection = Table.project(SupportCustomersResource.table, ["id", "name"])
const SupportAgentProjection = Table.project(SupportAgentsResource.table, ["id", "name", "onDuty"])

const SupportCaseEventProjection = Table.project(SupportCaseEventsResource.table, [
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

const supportCaseDetail = SqlSchema.findOneOption({
  Request: GetSupportCaseInputSchema,
  Result: SupportCaseDetailProjectionSchema,
  execute: Effect.fn("SupportCases.detailQuery")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<SqliteRow>`
      SELECT ${SupportCaseProjection.object(sql, "support_case")} AS ${sql("case")},
        ${SupportCustomerProjection.object(sql, "customer")} AS ${sql("customer")},
        (
          SELECT ${SupportAgentProjection.object(sql, "agent")}
          FROM ${sql(SupportAgentsResource.table.name)} agent
          WHERE agent.${sql("id")} = support_case.${sql("assignedAgentId")}
          LIMIT 1
        ) AS ${sql("agent")},
        COALESCE((
          SELECT json_group_array(${SupportCaseEventProjection.object(sql, "event")})
          FROM (
            SELECT * FROM ${sql(SupportCaseEventsResource.table.name)}
            WHERE ${sql("caseId")} = support_case.${sql("id")}
            ORDER BY ${sql("occurredAt")}, ${sql("id")}
          ) event
        ), '[]') AS ${sql("events")}
      FROM ${sql(SupportCasesResource.table.name)} support_case
      INNER JOIN ${sql(SupportCustomersResource.table.name)} customer
        ON customer.${sql("id")} = support_case.${sql("customerId")}
      WHERE support_case.${sql("id")} = ${input.caseId}
      LIMIT 1
    `
  }),
})

const requireCustomer = Effect.fn("SupportCases.requireCustomer")(function* (customerId: string) {
  return yield* pipe(
    SupportCustomersResource.repository.get(customerId),
    Effect.catchTag("ResourceNotFound", () => SupportCustomerNotFound.make({ customerId })),
  )
})

const requireAgent = Effect.fn("SupportCases.requireAgent")(function* (agentId: string) {
  return yield* pipe(
    SupportAgentsResource.repository.get(agentId),
    Effect.catchTag("ResourceNotFound", () => SupportAgentNotFound.make({ agentId })),
  )
})

const requireCase = Effect.fn("SupportCases.requireCase")(function* (caseId: string) {
  return yield* pipe(
    SupportCasesResource.repository.get(caseId),
    Effect.catchTag("ResourceNotFound", () => SupportCaseNotFound.make({ caseId })),
  )
})

const sameAction = Equivalence.strictEqual<string>()

const assignmentFor = Effect.fn("SupportCases.assignmentFor")(function* (
  input: typeof AdvanceSupportCaseInputSchema.Type,
) {
  const assigning = sameAction(input.action, "assign")

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

const SupportOperation = Operation.family("support.", SupportCasesUnavailable)
const SupportTransaction = SupportOperation.transactional()

const openCase = SupportTransaction.make({
  name: "openCase",
  payload: OpenSupportCaseInputSchema,
  success: SupportCasesResource.table.rowSchema,
  errors: SupportCustomerNotFound,
  dependencies: [SupportCustomersResource, SupportCasesResource, SupportCaseEventsResource],
  handler: Effect.fn("SupportCases.openCase")(function* (input) {
    yield* requireCustomer(input.customerId)

    const supportCase = yield* pipe(
      Option.fromNullishOr(input.priority),
      Option.match({
        onNone: () => SupportCasesResource.repository.create({
          customerId: input.customerId,
          subject: input.subject,
        }),
        onSome: (priority) => SupportCasesResource.repository.create({
          customerId: input.customerId,
          subject: input.subject,
          priority,
        }),
      }),
    )

    yield* SupportCaseEventsResource.repository.create({
      caseId: supportCase.id,
      kind: "opened",
    })

    return supportCase
  }),
})

const advanceCaseErrorsSchema = Schema.Union([
  SupportCaseNotFound,
  SupportAgentRequired,
  SupportAgentNotFound,
  AgentOffDuty,
  VersionConflict,
  SupportCaseTransitions.Error,
])

const advanceCase = SupportTransaction.make({
  name: "advanceCase",
  payload: AdvanceSupportCaseInputSchema,
  success: SupportCasesResource.table.rowSchema,
  errors: advanceCaseErrorsSchema,
  dependencies: [SupportCasesResource, SupportAgentsResource, SupportCaseEventsResource],
  handler: Effect.fn("SupportCases.advanceCase")(function* (input) {
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

    const supportCase = yield* SupportCasesResource.repository.transition(
      input.caseId,
      input.action,
      transitionChanges,
      input.expectedVersion,
    )

    yield* pipe(
      Option.fromNullishOr(input.note),
      Option.match({
        onNone: () => SupportCaseEventsResource.repository.create({
          caseId: supportCase.id,
          kind: eventKinds[input.action],
          agentId: supportCase.assignedAgentId,
        }),
        onSome: (note) => SupportCaseEventsResource.repository.create({
          caseId: supportCase.id,
          kind: eventKinds[input.action],
          agentId: supportCase.assignedAgentId,
          note,
        }),
      }),
    )

    return supportCase
  }),
})

const caseDetail = SupportOperation.make({
  name: "caseDetail",
  payload: GetSupportCaseInputSchema,
  success: SupportCaseDetail,
  errors: SupportCaseNotFound,
  dependencies: [SupportCasesResource, SupportCustomersResource, SupportAgentsResource, SupportCaseEventsResource],
  handler: Effect.fn("SupportCases.caseDetail")(function* (input) {
    yield* requireCase(input.caseId)
    const detail = yield* supportCaseDetail(input)

    if (Option.isNone(detail)) return yield* SupportCaseNotFound.make({ caseId: input.caseId })
    return detail.value
  }),
})

const caseBoard = SqliteView.listOperation({
  name: "support.board",
  unavailable: SupportCasesUnavailable,
  list: SupportCaseBoardList,
})

export const SupportCaseOperations = Operation.bundle(openCase, advanceCase, caseDetail, caseBoard)
