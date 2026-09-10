import { Array, Cause, DateTime, Effect, Equivalence, Exit, Layer, Match, Option, Schema, Struct, pipe } from "effect"
import { ClusterError, RunnerStorage, Sharding } from "effect/unstable/cluster"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Activity, DurableClock, DurableDeferred, DurableQueue, Workflow } from "effect/unstable/workflow"
import { Authorization, AuthorizationSubject, Forbidden } from "effect-domains/authorization"
import { EntitlementRequired, EntitlementUnavailable } from "effect-domains/entitlements"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"

import {
  PollReportExportSchema,
  ReleaseReportSchema,
  ReportArtifactSchema,
  ReportExportJobSchema,
  ReportExportPollResultSchema,
  ReportExportRequestSchema,
  ReportReleaseSchema,
  type ReportExportRequest,
} from "./contracts.ts"

import { ReportExportGenerationAuthorization, ReportExportOperatorAuthorization } from "./authorization.ts"

const groupsSchema = Schema.Array(Schema.String)

class ReportExportRunnerStatus extends Schema.Class<ReportExportRunnerStatus>("ReportExportRunnerStatus")({
  host: Schema.String,
  port: Schema.Int,
  healthy: Schema.Boolean,
  groups: groupsSchema,
  weight: Schema.Finite,
}) {}

const runnersSchema = Schema.Array(ReportExportRunnerStatus)

class ReportExportStatus extends Schema.Class<ReportExportStatus>("ReportExportStatus")({
  activeEntities: Schema.Int,
  shuttingDown: Schema.Boolean,
  runners: runnersSchema,
}) {}

export const ReportArtifactQueue = DurableQueue.make({
  name: "ReportExports.WriteArtifact",
  payload: ReportExportJobSchema,
  success: ReportArtifactSchema,
  idempotencyKey: ({ executionId }) => executionId,
})

const ReportReleaseApproval = DurableDeferred.make("ReportExports.ReleaseApproval", {
  success: ReportReleaseSchema,
})

const WorkflowRequestSchema = Schema.Struct({ ...ReportExportRequestSchema.fields, accountId: Schema.String })

export const FinancialReportExport = Workflow.make("Generate", {
  payload: WorkflowRequestSchema,
  success: ReportArtifactSchema,
  idempotencyKey: ({ accountId, report }) => JSON.stringify([accountId, report.reportId]),
})


export const executeFinancialReportExport = Effect.fn("ReportExports.Generate.execute")(
  function* (request: ReportExportRequest, executionId: string) {
    yield* DurableClock.sleep({
      name: "ReportExports.BeforeArtifact",
      duration: "5 seconds",
      inMemoryThreshold: 0,
    })

    const approvalRequired = Equivalence.strictEqual<string>()(request.report.releasePolicy, "operatorApproval")
    const release = approvalRequired ? yield* DurableDeferred.await(ReportReleaseApproval) : null
    const releasedBy = release?.releasedBy ?? null

    const totals = Array.reduce(request.lines, { totalDebitMinor: 0, totalCreditMinor: 0 }, (totals, line) => {
      const debit = Equivalence.strictEqual<string>()(line.direction, "debit")

      return debit
        ? Struct.evolve(totals, { totalDebitMinor: (total) => total + line.amountMinor })
        : Struct.evolve(totals, { totalCreditMinor: (total) => total + line.amountMinor })
    })

    const render = Effect.sync(() => {
      const startsAt = DateTime.formatIso(request.report.reportingPeriod.startsAt)
      const endsAt = DateTime.formatIso(request.report.reportingPeriod.endsAt)

      const contents = JSON.stringify({
        report: {
          reportId: request.report.reportId,
          reportingPeriod: { startsAt, endsAt },
          currency: request.report.currency,
        },
        release: { policy: request.report.releasePolicy, releasedBy },
        lines: request.lines,
        totals,
      }, null, 2)

      return ReportExportJobSchema.make({
        executionId,
        report: request.report,
        lines: request.lines,
        releasedBy,
        ...totals,
        contents: `${contents}\n`,
      })
    })

    const job = yield* Activity.make({
      name: "ReportExports.RenderArtifact",
      success: ReportExportJobSchema,
      execute: render,
    })

    return yield* DurableQueue.process(ReportArtifactQueue, job)
  },
)


const ReleaseReport = Rpc.make("ReportExport.Release", {
  payload: ReleaseReportSchema,
  success: Schema.Void,
})

const PollReportExport = Rpc.make("ReportExport.Poll", {
  payload: PollReportExportSchema,
  success: ReportExportPollResultSchema,
})

const ReportExportClusterStatus = Rpc.make("ReportExport.Status", {
  success: ReportExportStatus,
  error: ClusterError.PersistenceError,
})

const reportPayloadSchema = Schema.toCodecJson(ReportExportRequestSchema)
const artifactPayloadSchema = Schema.toCodecJson(ReportArtifactSchema)
const generationErrorsSchema = Schema.Union([Forbidden, EntitlementRequired, EntitlementUnavailable])
const generate = Rpc.make("ReportExport.Generate", { payload: reportPayloadSchema, success: artifactPayloadSchema, error: generationErrorsSchema })
const generateDiscard = Rpc.make("ReportExport.GenerateDiscard", { payload: reportPayloadSchema, success: Schema.String, error: generationErrorsSchema })
const resume = Rpc.make("ReportExport.GenerateResume", { payload: PollReportExportSchema, success: Schema.Void, error: Forbidden })

const generationGroup = RpcGroup.make(generate, generateDiscard)
  .middleware(AuthorizationRpc)
  .annotateRpcs(AuthorizationRpc.policy, ReportExportGenerationAuthorization)

const operatorGroup = RpcGroup.make(resume, ReleaseReport, PollReportExport, ReportExportClusterStatus)
  .middleware(AuthorizationRpc)
  .annotateRpcs(AuthorizationRpc.policy, ReportExportOperatorAuthorization)

const authorizedRequest = Effect.fn("ReportExports.authorizedRequest")(function* (request: ReportExportRequest) {
  const subject = yield* Authorization.requireSubject(ReportExportGenerationAuthorization)
  return WorkflowRequestSchema.make({ ...request, accountId: subject.tenantId })
})

const generationHandlers = generationGroup.toLayer({
  "ReportExport.Generate": Effect.fn("ReportExports.generate")(function* (request) {
    const payload = yield* authorizedRequest(request)
    return yield* FinancialReportExport.execute(payload)
  }),
  "ReportExport.GenerateDiscard": Effect.fn("ReportExports.generateDiscard")(function* (request) {
    const payload = yield* authorizedRequest(request)
    return yield* FinancialReportExport.execute(payload, { discard: true })
  }),
})

const operatorHandlers = operatorGroup.toLayer({
  "ReportExport.GenerateResume": Effect.fn("ReportExports.resume")(function* ({ executionId }) {
    yield* Authorization.requireSubject(ReportExportOperatorAuthorization)
    yield* FinancialReportExport.resume(executionId)
  }),
  "ReportExport.Release": Effect.fn("ReportExports.Release")(function* ({ executionId }) {
    const subject = yield* AuthorizationSubject
    const releasedBy = yield* pipe(Schema.decodeUnknownEffect(Schema.NonEmptyString)(subject["userId"]), Effect.orDie)

    const token = DurableDeferred.tokenFromExecutionId(ReportReleaseApproval, {
      workflow: FinancialReportExport,
      executionId,
    })

    const value = ReportReleaseSchema.make({ releasedBy })
    yield* DurableDeferred.succeed(ReportReleaseApproval, { token, value })
  }),
  "ReportExport.Poll": Effect.fn("ReportExports.Poll")(function* ({ executionId }) {
    const result = yield* FinancialReportExport.poll(executionId)

    return Option.match(result, {
      onNone: () => ReportExportPollResultSchema.make({ _tag: "PendingOrUnknown" }),
      onSome: (value) => pipe(Match.value(value), Match.tag("Suspended", () => ReportExportPollResultSchema.make({ _tag: "PendingOrUnknown" })),
      Match.tag("Complete", ({ exit }) => Exit.isSuccess(exit)
        ? ReportExportPollResultSchema.make({ _tag: "Succeeded", ...exit.value })
        : ReportExportPollResultSchema.make({ _tag: "Failed", reason: Cause.pretty(exit.cause) })),
      Match.exhaustive,),
    })
  }),
  "ReportExport.Status": Effect.fn("ReportExports.Status")(function* () {
    const sharding = yield* Sharding.Sharding
    const storage = yield* RunnerStorage.RunnerStorage

    const snapshot = yield* Effect.all({
      activeEntities: sharding.activeEntityCount,
      shuttingDown: sharding.isShutdown,
      runners: storage.getRunners,
    })

    const runners = Array.map(snapshot.runners, ([runner, healthy]) => ReportExportRunnerStatus.make({
      host: runner.address.host,
      port: runner.address.port,
      healthy,
      groups: runner.groups,
      weight: runner.weight,
    }))

    return ReportExportStatus.make({ ...snapshot, runners })
  }),
})

export const ReportExportCommands = {
  group: generationGroup.merge(operatorGroup),
  handlers: Layer.merge(generationHandlers, operatorHandlers),
}
