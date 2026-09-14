import {
  Array,
  Context,
  DateTime,
  Effect,
  Equivalence,
  Layer,
  Option,
  Schema,
  pipe,
} from "effect"

import { SqlClient } from "effect/unstable/sql"
import { Authorization } from "effect-domains/authorization"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"

import {
  ReportArtifactSchema,
  ReportExportCancellationRejected,
  ReportExportExecutionStatusSchema,
  ReportExportNotFound,
  ReportExportRequestSchema,
  ReportExportUnavailable,
} from "./contracts.ts"

export const ReportExportExecutionSchema = Schema.Struct({
  id: identifier(Schema.String),
  tenantId: Schema.NonEmptyString,
  request: ReportExportRequestSchema,
  status: ReportExportExecutionStatusSchema,
  artifact: Schema.NullOr(ReportArtifactSchema),
  failure: Schema.NullOr(Schema.String),
})

const ReportExportExecutionRowSchema = Schema.Struct({
  ...ReportExportExecutionSchema.fields,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
})

const StoredReportExportRequestSchema = Schema.fromJsonString(Schema.toCodecJson(ReportExportRequestSchema))
const StoredReportArtifactSchema = Schema.fromJsonString(Schema.toCodecJson(ReportArtifactSchema))

const StoredReportExportExecutionSchema = Schema.Struct({
  ...ReportExportExecutionRowSchema.fields,
  request: StoredReportExportRequestSchema,
  artifact: Schema.NullOr(StoredReportArtifactSchema),
})

const StoredExecutionResultSchema = Schema.Struct({
  ...ReportExportExecutionSchema.fields,
  request: StoredReportExportRequestSchema,
  artifact: Schema.NullOr(StoredReportArtifactSchema),
})

export const ReportExportExecutionsResource = Resource.make({
  authorization: Authorization.public,
  name: "report_export_executions",
  schema: ReportExportExecutionRowSchema,
  storage: StoredReportExportExecutionSchema,
  operations: {},
  relations: {
    indexes: [{ fields: ["status", "createdAt"] }],
  },
})

export type ReportExportExecution = typeof ReportExportExecutionSchema.Type
type Request = typeof ReportExportRequestSchema.Type
type Artifact = typeof ReportArtifactSchema.Type

export class ReportExportExecutionStore extends Context.Service<ReportExportExecutionStore, {
  readonly accept: (input: Readonly<{
    id: string
    tenantId: string
    request: Request
  }>) => Effect.Effect<ReportExportExecution, ReportExportUnavailable>
  readonly pending: Effect.Effect<ReadonlyArray<ReportExportExecution>, ReportExportUnavailable>
  readonly find: (executionId: string) => Effect.Effect<Option.Option<ReportExportExecution>, ReportExportUnavailable>
  readonly require: (executionId: string) => Effect.Effect<ReportExportExecution, ReportExportUnavailable | ReportExportNotFound>
  readonly markDispatched: (executionId: string) => Effect.Effect<void, ReportExportUnavailable>
  readonly beginWriting: (executionId: string) => Effect.Effect<boolean, ReportExportUnavailable>
  readonly succeed: (executionId: string, artifact: Artifact) => Effect.Effect<void, ReportExportUnavailable>
  readonly fail: (executionId: string, reason: string) => Effect.Effect<void, ReportExportUnavailable>
  readonly cancel: (executionId: string) => Effect.Effect<
    ReportExportExecution,
    ReportExportUnavailable | ReportExportNotFound | ReportExportCancellationRejected
  >
}>()("@effect-domains/example-report-exports/ReportExportExecutionStore") {}

const storeUnavailable = (_cause: unknown) => ReportExportUnavailable.make({})
const sameStatus = Equivalence.strictEqual<typeof ReportExportExecutionStatusSchema.Type>()
const encodeExecution = Schema.encodeUnknownEffect(ReportExportExecutionsResource.table.storageSchema)
const decodeExecution = Schema.decodeUnknownEffect(StoredExecutionResultSchema)
const encodeArtifact = Schema.encodeUnknownEffect(StoredReportArtifactSchema)

const KnownStoreErrorSchema = Schema.Struct({
  _tag: Schema.Literals([
    "ReportExportCancellationRejected",
    "ReportExportNotFound",
    "ReportExportUnavailable",
  ]),
})

const isKnownStoreError = Schema.is(KnownStoreErrorSchema)

const knownCancelError = (error: unknown) => isKnownStoreError(error)
  ? error as ReportExportUnavailable | ReportExportNotFound | ReportExportCancellationRejected
  : storeUnavailable(error)

const makeExecutionStore = Effect.gen(function* () {
  const database = yield* SqlClient.SqlClient
  const table = database(ReportExportExecutionsResource.table.name)

  const find = Effect.fn("ReportExports.ExecutionStore.find")(function* (executionId: string) {
    const rows = yield* database<Readonly<Record<string, unknown>>>`
      SELECT id, tenantId, request, status, artifact, failure
      FROM ${table}
      WHERE id = ${executionId}
    `

    const row = Array.head(rows)
    if (Option.isNone(row)) return Option.none<ReportExportExecution>()

    const decoded = yield* decodeExecution(row.value)
    return Option.some(decoded)
  }, Effect.mapError(storeUnavailable))

  const requireExecution = Effect.fn("ReportExports.ExecutionStore.require")(function* (executionId: string) {
    const execution = yield* find(executionId)
    if (Option.isNone(execution)) return yield* ReportExportNotFound.make({ executionId })
    return execution.value
  })

  const pending = pipe(
    database<Readonly<Record<string, unknown>>>`
      SELECT id, tenantId, request, status, artifact, failure
      FROM ${table}
      WHERE status = 'accepted'
      ORDER BY createdAt ASC, id ASC
    `,
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeExecution(row, { errors: "all" }))),
    Effect.mapError(storeUnavailable),
  )

  const markDispatched = Effect.fn("ReportExports.ExecutionStore.markDispatched")(function* (executionId: string) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now)

    yield* database`
      UPDATE ${table}
      SET status = 'dispatched', updatedAt = ${updatedAt}
      WHERE id = ${executionId} AND status = 'accepted'
    `
  }, Effect.mapError(storeUnavailable))

  const beginWriting = Effect.fn("ReportExports.ExecutionStore.beginWriting")(function* (executionId: string) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now)

    const rows = yield* database<Readonly<{ id: string }>>`
      UPDATE ${table}
      SET status = 'writing', updatedAt = ${updatedAt}
      WHERE id = ${executionId} AND status IN ('accepted', 'dispatched', 'writing')
      RETURNING id
    `

    return Array.isReadonlyArrayNonEmpty(rows)
  }, Effect.mapError(storeUnavailable))

  const succeed = Effect.fn("ReportExports.ExecutionStore.succeed")(function* (
    executionId: string,
    artifact: Artifact,
  ) {
    const artifactJson = yield* encodeArtifact(artifact)
    const updatedAt = DateTime.formatIso(yield* DateTime.now)

    yield* database`
      UPDATE ${table}
      SET status = 'succeeded', artifact = ${artifactJson}, failure = NULL, updatedAt = ${updatedAt}
      WHERE id = ${executionId} AND status = 'writing'
    `
  }, Effect.mapError(storeUnavailable))

  const fail = Effect.fn("ReportExports.ExecutionStore.fail")(function* (
    executionId: string,
    reason: string,
  ) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now)

    yield* database`
      UPDATE ${table}
      SET status = 'failed', failure = ${reason}, updatedAt = ${updatedAt}
      WHERE id = ${executionId} AND status NOT IN ('succeeded', 'cancelled')
    `
  }, Effect.mapError(storeUnavailable))

  const cancel = Effect.fn("ReportExports.ExecutionStore.cancel")(function* (executionId: string) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now)

    yield* database`
      UPDATE ${table}
      SET status = 'cancelled', updatedAt = ${updatedAt}
      WHERE id = ${executionId} AND status IN ('accepted', 'dispatched')
    `

    const execution = yield* requireExecution(executionId)
    if (sameStatus(execution.status, "cancelled")) return execution
    return yield* ReportExportCancellationRejected.make({ executionId, status: execution.status })
  }, Effect.mapError(knownCancelError))

  const accept = Effect.fn("ReportExports.ExecutionStore.accept")(function* ({ id, request, tenantId }) {
    const now = yield* DateTime.now

    const encoded = encodeExecution({
      id,
      tenantId,
      request,
      status: "accepted",
      artifact: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
    })

    const execution = yield* pipe(encoded, Effect.mapError(storeUnavailable))

    yield* pipe(
      database`
        INSERT INTO ${table}
          (id, tenantId, request, status, artifact, failure, createdAt, updatedAt)
        VALUES
          (${execution.id}, ${execution.tenantId}, ${execution.request}, ${execution.status},
           ${execution.artifact}, ${execution.failure}, ${execution.createdAt}, ${execution.updatedAt})
        ON CONFLICT(id) DO NOTHING
      `,
      Effect.mapError(storeUnavailable),
    )

    const accepted = yield* find(id)
    if (Option.isNone(accepted)) return yield* storeUnavailable(`Accepted execution missing: ${id}`)
    return accepted.value
  })

  return ReportExportExecutionStore.of({
    accept,
    pending,
    find,
    require: requireExecution,
    markDispatched,
    beginWriting,
    succeed,
    fail,
    cancel,
  })
})

export const ReportExportExecutionStoreLive = Layer.effect(ReportExportExecutionStore, makeExecutionStore)
