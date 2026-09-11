import { DateTime, Schema, pipe } from "effect"
import { ClusterError } from "effect/unstable/cluster"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Forbidden } from "effect-domains/authorization"
import { EntitlementRequired, EntitlementUnavailable } from "effect-domains/entitlements"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"

const isReportId = Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const isLedgerAccountCode = Schema.isPattern(/^[0-9]{4,10}$/)

export const MoneyMinorSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

export const FinancialReportIdSchema = pipe(
  Schema.String.check(isReportId),
  Schema.brand("FinancialReportId"),
)

export const CurrencyCodeSchema = Schema.Literals([
  "AUD",
  "CAD",
  "EUR",
  "GBP",
  "JPY",
  "USD",
])


const PositiveMoneyMinorSchema = MoneyMinorSchema.check(Schema.isGreaterThan(0))

export const FinancialReportLineSchema = Schema.Struct({
  accountCode: Schema.String.check(isLedgerAccountCode),
  description: Schema.NonEmptyString,
  direction: Schema.Literals(["debit", "credit"]),
  amountMinor: PositiveMoneyMinorSchema,
})

export const ReportingPeriodSchema = Schema.Struct({
  startsAt: Schema.DateTimeUtc,
  endsAt: Schema.DateTimeUtc,
}).check(Schema.makeFilter((period) => {
  const ordered = DateTime.isLessThan(period.startsAt, period.endsAt)

  return ordered

    ? undefined
    : { path: ["endsAt"], issue: "reporting period must end after it starts" }
}))

export const ReportReleasePolicySchema = Schema.Literals([
  "automatic",
  "operatorApproval",
])

export const FinancialReportSchema = Schema.Struct({
  reportId: FinancialReportIdSchema,
  reportingPeriod: ReportingPeriodSchema,
  currency: CurrencyCodeSchema,
  releasePolicy: ReportReleasePolicySchema,
})

export const ReportExportRequestSchema = Schema.Struct({
  report: FinancialReportSchema,
  lines: Schema.NonEmptyArray(FinancialReportLineSchema),
})

export const ReportArtifactSchema = Schema.Struct({
  artifactPath: Schema.String,
  reportId: FinancialReportIdSchema,
  reportingPeriod: ReportingPeriodSchema,
  currency: CurrencyCodeSchema,
  releasePolicy: ReportReleasePolicySchema,
  releasedBy: Schema.NullOr(Schema.NonEmptyString),
  lineCount: Schema.Int,
  totalDebitMinor: MoneyMinorSchema,
  totalCreditMinor: MoneyMinorSchema,
})

export const ReportExportJobSchema = Schema.Struct({
  executionId: Schema.String,
  report: FinancialReportSchema,
  lines: Schema.NonEmptyArray(FinancialReportLineSchema),
  releasedBy: Schema.NullOr(Schema.NonEmptyString),
  totalDebitMinor: MoneyMinorSchema,
  totalCreditMinor: MoneyMinorSchema,
  contents: Schema.String,
})

export const ReportReleaseSchema = Schema.Struct({
  releasedBy: Schema.NonEmptyString,
})

export const ReleaseReportSchema = Schema.Struct({
  executionId: Schema.String,
})

export const PollReportExportSchema = Schema.Struct({
  executionId: Schema.String,
})

export const ReportExportPollResultSchema = Schema.Union([
  Schema.TaggedStruct("PendingOrUnknown", {}),
  Schema.TaggedStruct("Succeeded", ReportArtifactSchema.fields),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
])

export const ReportExportRunnerStatusSchema = Schema.Struct({
  host: Schema.String,
  port: Schema.Int,
  healthy: Schema.Boolean,
  groups: Schema.Array(Schema.String),
  weight: Schema.Finite,
})

export const ReportExportStatusSchema = Schema.Struct({
  activeEntities: Schema.Int,
  shuttingDown: Schema.Boolean,
  runners: Schema.Array(ReportExportRunnerStatusSchema),
})

const reportPayloadSchema = Schema.toCodecJson(ReportExportRequestSchema)
const artifactPayloadSchema = Schema.toCodecJson(ReportArtifactSchema)
const generationErrorsSchema = Schema.Union([Forbidden, EntitlementRequired, EntitlementUnavailable])

const generate = Rpc.make("ReportExport.Generate", { payload: reportPayloadSchema, success: artifactPayloadSchema, error: generationErrorsSchema })
const generateDiscard = Rpc.make("ReportExport.GenerateDiscard", { payload: reportPayloadSchema, success: Schema.String, error: generationErrorsSchema })
const resume = Rpc.make("ReportExport.GenerateResume", { payload: PollReportExportSchema, success: Schema.Void, error: Forbidden })
const release = Rpc.make("ReportExport.Release", { payload: ReleaseReportSchema, success: Schema.Void })
const poll = Rpc.make("ReportExport.Poll", { payload: PollReportExportSchema, success: ReportExportPollResultSchema })
const status = Rpc.make("ReportExport.Status", { success: ReportExportStatusSchema, error: ClusterError.PersistenceError })

export const ReportExportGenerationRpcs = RpcGroup.make(generate, generateDiscard).middleware(AuthorizationRpc)
export const ReportExportOperatorRpcs = RpcGroup.make(resume, release, poll, status).middleware(AuthorizationRpc)
export const ReportExportRpcs = ReportExportGenerationRpcs.merge(ReportExportOperatorRpcs)

export interface ReportExportRequest extends Schema.Schema.Type<typeof ReportExportRequestSchema> {}
export interface ReportExportJob extends Schema.Schema.Type<typeof ReportExportJobSchema> {}

interface FinancialReportLine extends Schema.Schema.Type<typeof FinancialReportLineSchema> {}
interface ReportingPeriod extends Schema.Schema.Type<typeof ReportingPeriodSchema> {}
interface FinancialReport extends Schema.Schema.Type<typeof FinancialReportSchema> {}
interface ReportArtifact extends Schema.Schema.Type<typeof ReportArtifactSchema> {}
interface ReportRelease extends Schema.Schema.Type<typeof ReportReleaseSchema> {}
interface ReleaseReport extends Schema.Schema.Type<typeof ReleaseReportSchema> {}
interface PollReportExport extends Schema.Schema.Type<typeof PollReportExportSchema> {}
