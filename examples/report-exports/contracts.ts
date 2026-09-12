import { DateTime, Schema, pipe } from "effect"
import { ClusterError } from "effect/unstable/cluster"
import { Forbidden } from "effect-domains/authorization"
import { SafeIntSchema } from "effect-domains/domain"
import { EntitlementRequired, EntitlementUnavailable } from "effect-domains/entitlements"

const isReportId = Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const isLedgerAccountCode = Schema.isPattern(/^[0-9]{4,10}$/)

export const MoneyMinorSchema = SafeIntSchema.check(Schema.isGreaterThanOrEqualTo(0))

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
  lineCount: SafeIntSchema,
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
  port: SafeIntSchema,
  healthy: Schema.Boolean,
  groups: Schema.Array(Schema.String),
  weight: Schema.Finite,
})

export const ReportExportStatusSchema = Schema.Struct({
  activeEntities: SafeIntSchema,
  shuttingDown: Schema.Boolean,
  runners: Schema.Array(ReportExportRunnerStatusSchema),
})

export class ReportExportUnavailable extends Schema.TaggedError<ReportExportUnavailable>()(
  "ReportExportUnavailable",
  {},
) {}

export const ReportExportGenerationErrorsSchema = Schema.Union([
  Forbidden,
  EntitlementRequired,
  EntitlementUnavailable,
])

export const ReportExportOperatorErrorsSchema = Schema.Union([
  Forbidden,
  ClusterError.PersistenceError,
])

export interface ReportExportRequest extends Schema.Schema.Type<typeof ReportExportRequestSchema> {}
export interface ReportExportJob extends Schema.Schema.Type<typeof ReportExportJobSchema> {}

interface FinancialReportLine extends Schema.Schema.Type<typeof FinancialReportLineSchema> {}
interface ReportingPeriod extends Schema.Schema.Type<typeof ReportingPeriodSchema> {}
interface ReportArtifact extends Schema.Schema.Type<typeof ReportArtifactSchema> {}
interface ReportRelease extends Schema.Schema.Type<typeof ReportReleaseSchema> {}
interface ReleaseReport extends Schema.Schema.Type<typeof ReleaseReportSchema> {}
