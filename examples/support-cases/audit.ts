import { DateTime, Effect, Function, Schema, Struct, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ExampleRoles, ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { Authorization } from "effect-domains/authorization"
import { Command } from "effect-domains/command"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { SupportCasesUnavailable } from "./domain.ts"

export const SupportCaseAuditActionSchema = Schema.Literals([
  "open",
  "triage",
  "assign",
  "resolve",
  "reopen",
])

export const SupportCaseAuditSchema = Schema.Struct({
  id: identifier(Schema.NonEmptyString),
  occurredAt: Schema.DateTimeUtc,
  action: SupportCaseAuditActionSchema,
  outcome: Schema.Literal("succeeded"),
  actorId: Schema.NonEmptyString,
  targetId: Schema.NonEmptyString,
  traceId: Schema.NullOr(Schema.NonEmptyString),
})

const SupportCaseAuditList = Resource.list({
  filter: ["targetId", "action", "actorId"],
  range: ["occurredAt"],
  order: [["occurredAt", "asc"]],
  limit: 100,
  publish: false,
})

export const SupportCaseAuditsResource = Resource.define({
  name: "support_case_audits",
  schema: SupportCaseAuditSchema,
  authorization: Authorization.public,
  capabilities: [SupportCaseAuditList],
  relations: {
    indexes: [
      { fields: ["targetId", "occurredAt"] },
      { fields: ["actorId", "occurredAt"] },
    ],
  },
})

const auditTable = Resource.table(SupportCaseAuditsResource)

const activeTraceId = pipe(
  Effect.currentSpan,
  Effect.match({
    onFailure: Function.constant(null),
    onSuccess: Struct.get("traceId"),
  }),
)

export const appendSupportCaseAudit = Effect.fn("SupportCases.appendAudit")(function* (input: Readonly<{
  id: string
  action: typeof SupportCaseAuditActionSchema.Type
  actorId: string
  targetId: string
}>) {
  const database = yield* SqlClient.SqlClient
  const table = database(auditTable.name)
  const occurredAt = DateTime.formatIso(yield* DateTime.now)
  const traceId = yield* activeTraceId

  yield* database`
    INSERT INTO ${table} (id, occurredAt, action, outcome, actorId, targetId, traceId)
    VALUES (${input.id}, ${occurredAt}, ${input.action}, 'succeeded', ${input.actorId}, ${input.targetId}, ${traceId})
    ON CONFLICT(id) DO NOTHING
  `
})

const SupportAuditInputSchema = Schema.Struct({ caseId: Schema.NonEmptyString })
const supportAuditTable = Resource.table(SupportCaseAuditsResource)

const SupportAuditCommand = Command
  .family("support.", SupportCasesUnavailable)
  .authorized(ExampleRoles.admin)

const SupportAuditRowsSchema = Schema.Array(supportAuditTable.rowSchema)

const auditTrailSpec = SupportAuditCommand.define({
  name: "auditTrail",
  payload: SupportAuditInputSchema,
  success: SupportAuditRowsSchema,
  dependencies: [SupportCaseAuditsResource],
})

export const SupportCaseAuditOperation = Command.implement(
  auditTrailSpec,
  Effect.fn("SupportCases.auditTrail")(function* (
    { caseId }: typeof SupportAuditInputSchema.Type,
    _subject: typeof ExampleSubjectSchema.Type,
  ) {

    const page = yield* Resource.repository(SupportCaseAuditsResource).list({
      filter: { targetId: caseId },
      limit: 100,
    })

    return page.items
  }),
)
