import { DateTime, Effect, Function, Schema, Struct, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ExampleRoles, ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { Authorization } from "effect-domains/authorization"
import { Command } from "effect-domains/command"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { ReportExportUnavailable } from "./contracts.ts"

export const ReportExportAuditActionSchema = Schema.Literals([
  "release",
  "resume",
  "cancel",
  "reconcile",
])

export const ReportExportAuditSchema = Schema.Struct({
  id: identifier(Schema.NonEmptyString),
  occurredAt: Schema.DateTimeUtc,
  action: ReportExportAuditActionSchema,
  outcome: Schema.Literal("succeeded"),
  actorId: Schema.NonEmptyString,
  targetId: Schema.NonEmptyString,
  traceId: Schema.NullOr(Schema.NonEmptyString),
})

const ReportExportAuditList = Resource.list({
  filter: ["targetId", "action", "actorId"],
  range: ["occurredAt"],
  order: [["occurredAt", "asc"]],
  limit: 100,
  publish: false,
})

export const ReportExportAuditsResource = Resource.define({
  name: "report_export_audits",
  schema: ReportExportAuditSchema,
  authorization: Authorization.public,
  capabilities: [ReportExportAuditList],
  relations: {
    indexes: [
      { fields: ["targetId", "occurredAt"] },
      { fields: ["actorId", "occurredAt"] },
    ],
  },
})

const auditTable = Resource.table(ReportExportAuditsResource)

const activeTraceId = pipe(
  Effect.currentSpan,
  Effect.match({
    onFailure: Function.constant(null),
    onSuccess: Struct.get("traceId"),
  }),
)

export const appendReportExportAudit = Effect.fn("ReportExports.appendAudit")(function* (input: Readonly<{
  action: typeof ReportExportAuditActionSchema.Type
  actorId: string
  targetId: string
}>) {
  const database = yield* SqlClient.SqlClient
  const table = database(auditTable.name)
  const occurredAt = DateTime.formatIso(yield* DateTime.now)
  const traceId = yield* activeTraceId
  const id = `report-export:${input.action}:${input.targetId}`

  yield* database`
    INSERT INTO ${table} (id, occurredAt, action, outcome, actorId, targetId, traceId)
    VALUES (${id}, ${occurredAt}, ${input.action}, 'succeeded', ${input.actorId}, ${input.targetId}, ${traceId})
    ON CONFLICT(id) DO NOTHING
  `
})

const ReportAuditInputSchema = Schema.Struct({ executionId: Schema.NonEmptyString })

const ReportAuditCommand = Command
  .family("ReportExport.", ReportExportUnavailable)
  .authorized(ExampleRoles.admin)

const ReportAuditRowsSchema = Schema.Array(auditTable.rowSchema)

const auditTrailSpec = ReportAuditCommand.define({
  name: "AuditTrail",
  payload: ReportAuditInputSchema,
  success: ReportAuditRowsSchema,
  dependencies: [ReportExportAuditsResource],
})

export const ReportExportAuditOperation = Command.implement(
  auditTrailSpec,
  Effect.fn("ReportExports.AuditTrail")(function* (
    { executionId }: typeof ReportAuditInputSchema.Type,
    _subject: typeof ExampleSubjectSchema.Type,
  ) {

    const page = yield* Resource.repository(ReportExportAuditsResource).list({
      filter: { targetId: executionId },
      limit: 100,
    })

    return page.items
  }),
)
