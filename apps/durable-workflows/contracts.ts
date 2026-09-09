import { Schema } from "effect"

const isExportId = Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)

export const ExportIdSchema = Schema.String.check(isExportId)

export const ExportRecordSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  email: Schema.optionalKey(Schema.NonEmptyString),
  attributes: Schema.Record(Schema.String, Schema.Union([
    Schema.String,
    Schema.Finite,
    Schema.Boolean,
    Schema.Null,
  ])),
})

export const ExportRequestSchema = Schema.Struct({
  exportId: ExportIdSchema,
  records: Schema.NonEmptyArray(ExportRecordSchema),
  requiresApproval: Schema.Boolean,
})

export const ArtifactSchema = Schema.Struct({
  artifactPath: Schema.String,
  recordCount: Schema.Int,
})

export const ExportJobSchema = Schema.Struct({
  executionId: Schema.String,
  recordCount: Schema.Int,
  contents: Schema.String,
})

export const ApprovalSchema = Schema.Struct({
  approvedBy: Schema.NonEmptyString,
})

export const ApproveExportSchema = Schema.Struct({
  executionId: Schema.String,
})

export const PollExportSchema = Schema.Struct({
  executionId: Schema.String,
})

export const ExportPollResultSchema = Schema.Union([
  Schema.TaggedStruct("PendingOrUnknown", {}),
  Schema.TaggedStruct("Succeeded", ArtifactSchema.fields),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
])

interface ExportRecord extends Schema.Schema.Type<typeof ExportRecordSchema> {}
interface Approval extends Schema.Schema.Type<typeof ApprovalSchema> {}
interface ApproveExport extends Schema.Schema.Type<typeof ApproveExportSchema> {}
interface PollExport extends Schema.Schema.Type<typeof PollExportSchema> {}
export interface ExportRequest extends Schema.Schema.Type<typeof ExportRequestSchema> {}
interface Artifact extends Schema.Schema.Type<typeof ArtifactSchema> {}
export interface ExportJob extends Schema.Schema.Type<typeof ExportJobSchema> {}
