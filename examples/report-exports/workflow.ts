import { Array, Cause, DateTime, Effect, Equivalence, Exit, Function, Match, Option, Schema, Struct, pipe } from "effect"
import { RunnerStorage, Sharding } from "effect/unstable/cluster"
import { Activity, DurableClock, DurableDeferred, DurableQueue, Workflow } from "effect/unstable/workflow"
import { Command } from "effect-domains/command"

import {
  ReportArtifactConflict,
  ReportArtifactSchema,
  ReportExportCancellationRejected,
  ReportExportExecutionInputSchema,
  ReportExportGenerationErrorsSchema,
  ReportExportJobSchema,
  ReportExportOperatorErrorsSchema,
  ReportExportPollResultSchema,
  ReportExportRecoveryRejected,
  ReportExportRequestSchema,
  ReportExportRunnerStatusSchema,
  ReportExportStatusSchema,
  ReportExportUnavailable,
  ReportReleaseSchema,
  type ReportExportRequest,
} from "./contracts.ts"

import { ReportExportGenerationAuthorization } from "./authorization.ts"
import { type ReportExportExecution, ReportExportExecutionStore } from "./executions.ts"
import { writeReportArtifact } from "./writer.ts"

import {
  ExampleRoles,
  ExampleSubjectSchema,
} from "@effect-domains/example-support/subject"

export const ReportArtifactQueue = DurableQueue.make({
  name: "ReportExports.WriteArtifact",
  payload: ReportExportJobSchema,
  success: ReportArtifactSchema,
  idempotencyKey: ({ executionId }) => executionId,
})

const ReportReleaseApproval = DurableDeferred.make("ReportExports.ReleaseApproval", {
  success: ReportReleaseSchema,
})

export const ReportExportWorkflowRequestSchema = Schema.Struct({
  ...ReportExportRequestSchema.fields,
  accountId: Schema.String,
})

const ReportExportWorkflowErrorSchema = Schema.Union([ReportExportUnavailable, ReportArtifactConflict])

export const FinancialReportExport = Workflow.make("Generate", {
  payload: ReportExportWorkflowRequestSchema,
  error: ReportExportWorkflowErrorSchema,
  success: ReportArtifactSchema,
  idempotencyKey: ({ accountId, report }) => JSON.stringify([accountId, report.reportId]),
}).annotate(Workflow.SuspendOnFailure, true)

export const reportExportWorkflowRequest = (request: ReportExportRequest, tenantId: string) =>
  ReportExportWorkflowRequestSchema.make({ ...request, accountId: tenantId })

export const makeReportExportJob = (
  request: ReportExportRequest,
  executionId: string,
  releasedBy: string | null,
) => {
  const totals = Array.reduce(request.lines, { totalDebitMinor: 0, totalCreditMinor: 0 }, (totals, line) => {
    const debit = Equivalence.strictEqual<string>()(line.direction, "debit")

    return debit
      ? Struct.evolve(totals, { totalDebitMinor: (total) => total + line.amountMinor })
      : Struct.evolve(totals, { totalCreditMinor: (total) => total + line.amountMinor })
  })

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
}

export const executeFinancialReportExport = Effect.fn("ReportExports.Generate.execute")(
  function* (request: ReportExportRequest, executionId: string) {
    const executions = yield* ReportExportExecutionStore

    yield* DurableClock.sleep({
      name: "ReportExports.BeforeArtifact",
      duration: "5 seconds",
      inMemoryThreshold: 0,
    })

    const approvalRequired = Equivalence.strictEqual<string>()(request.report.releasePolicy, "operatorApproval")
    const release = approvalRequired ? yield* DurableDeferred.await(ReportReleaseApproval) : null
    const releasedBy = release?.releasedBy ?? null
    const reportJob = makeReportExportJob(request, executionId, releasedBy)
    const render = Effect.succeed(reportJob)

    const job = yield* Activity.make({
      name: "ReportExports.RenderArtifact",
      success: ReportExportJobSchema,
      execute: render,
    })

    const writable = yield* executions.beginWriting(executionId)
    if (!writable) return yield* Effect.interrupt

    const artifact = yield* DurableQueue.process(ReportArtifactQueue, job)
    yield* executions.succeed(executionId, artifact)
    return artifact
  },
)

const nativeUnavailable = (_cause: unknown) => ReportExportUnavailable.make({})
const native = <A, E, R>(effect: Effect.Effect<A, E, R>) => pipe(effect, Effect.mapError(nativeUnavailable))

export const releaseFinancialReportExport = Effect.fn("ReportExports.releaseExecution")(function* (
  executionId: string,
  releasedBy: string,
) {
  const token = DurableDeferred.tokenFromExecutionId(ReportReleaseApproval, {
    workflow: FinancialReportExport,
    executionId,
  })

  const release = ReportReleaseSchema.make({ releasedBy })
  const completion = DurableDeferred.succeed(ReportReleaseApproval, { token, value: release })

  yield* native(completion)
})

const sameStatus = Equivalence.strictEqual<"accepted" | "dispatched" | "writing" | "succeeded" | "cancelled" | "failed">()

const accept = Effect.fn("ReportExports.accept")(function* (
  request: ReportExportRequest,
  subject: typeof ExampleSubjectSchema.Type,
) {
  const workflow = reportExportWorkflowRequest(request, subject.tenantId)
  const executionId = yield* FinancialReportExport.executionId(workflow)
  const executions = yield* ReportExportExecutionStore
  yield* executions.accept({ id: executionId, tenantId: subject.tenantId, request })
  return { executionId, workflow } as const
})

const selectGenerateDiscard = Effect.fn("ReportExports.selectGenerateDiscard")(function* (
  request: ReportExportRequest,
  subject: typeof ExampleSubjectSchema.Type,
) {
  const accepted = yield* accept(request, subject)
  return accepted.executionId
})

// Call execute as a method because the native workflow reads its payload schema from `this`.
const selectGenerate = Effect.fn("ReportExports.selectGenerate")(function* (
  request: ReportExportRequest,
  subject: typeof ExampleSubjectSchema.Type,
) {
  const accepted = yield* accept(request, subject)
  const execution = FinancialReportExport.execute(accepted.workflow)
  return yield* native(execution)
})

const ReportGenerationCommand = Command
  .family("ReportExport.", ReportExportUnavailable)
  .authorized(ReportExportGenerationAuthorization)

const ReportOperatorCommand = Command
  .family("ReportExport.", ReportExportUnavailable)
  .authorized(ExampleRoles.admin)

const generateSpec = ReportGenerationCommand.define({
  name: "Generate",
  payload: ReportExportRequestSchema,
  success: ReportArtifactSchema,
  errors: ReportExportGenerationErrorsSchema,
})

const generate = Command.implement(generateSpec, selectGenerate)

const generateDiscardSpec = ReportGenerationCommand.define({
  name: "GenerateDiscard",
  payload: ReportExportRequestSchema,
  success: Schema.String,
  errors: ReportExportGenerationErrorsSchema,
})

const generateDiscard = Command.implement(generateDiscardSpec, selectGenerateDiscard)

const resumeSpec = ReportOperatorCommand.define({
  name: "GenerateResume",
  payload: ReportExportExecutionInputSchema,
  success: Schema.Void,
  errors: ReportExportOperatorErrorsSchema,
})

const resume = Command.implement(
  resumeSpec,
  Effect.fn("ReportExports.Resume")(function* ({ executionId }) {
    const executions = yield* ReportExportExecutionStore
    const execution = yield* executions.require(executionId)
    const terminalStatuses = ["cancelled", "failed", "succeeded"] as const

    const terminal = Array.some(
      terminalStatuses,
      (status) => sameStatus(execution.status, status),
    )

    if (terminal) {
      return yield* ReportExportRecoveryRejected.make({ executionId, status: execution.status })
    }

    const recovery = FinancialReportExport.resume(executionId)
    yield* native(recovery)
  }),
)

const releaseSpec = ReportOperatorCommand.define({
  name: "Release",
  payload: ReportExportExecutionInputSchema,
  success: Schema.Void,
  errors: ReportExportOperatorErrorsSchema,
})

const release = Command.implement(
  releaseSpec,
  Effect.fn("ReportExports.Release")(function* ({ executionId }, subject) {
    const executions = yield* ReportExportExecutionStore
    const execution = yield* executions.require(executionId)

    if (sameStatus(execution.status, "cancelled")) {
      return yield* ReportExportCancellationRejected.make({ executionId, status: execution.status })
    }

    const releasedBy = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(subject.userId)
    yield* releaseFinancialReportExport(executionId, releasedBy)
  }),
)

const cancelSpec = ReportOperatorCommand.define({
  name: "Cancel",
  payload: ReportExportExecutionInputSchema,
  success: Schema.Void,
  errors: ReportExportOperatorErrorsSchema,
})

const cancel = Command.implement(
  cancelSpec,
  Effect.fn("ReportExports.Cancel")(function* ({ executionId }) {
    const executions = yield* ReportExportExecutionStore
    yield* executions.cancel(executionId)
    const interruption = FinancialReportExport.interrupt(executionId)
    yield* native(interruption)
  }),
)

const applicationPollResult = (execution: ReportExportExecution) => pipe(
  Match.value(execution.status),
  Match.when("accepted", () => pipe(
    ReportExportPollResultSchema.make({
      _tag: "Pending",
      stage: execution.status,
    }),
    Option.some,
  )),
  Match.when("cancelled", () => pipe(
    ReportExportPollResultSchema.make({ _tag: "Cancelled" }),
    Option.some,
  )),
  Match.when("failed", () => pipe(
    ReportExportPollResultSchema.make({
      _tag: "Failed",
      reason: execution.failure ?? "Workflow failed",
    }),
    Option.some,
  )),
  Match.when("succeeded", () => {
    const artifact = Option.fromNullishOr(execution.artifact)
    if (Option.isNone(artifact)) return Option.none()

    return pipe(
      ReportExportPollResultSchema.make({
        _tag: "Succeeded",
        ...artifact.value,
      }),
      Option.some,
    )
  }),
  Match.orElse(() => Option.none()),
)

const pollSpec = ReportOperatorCommand.define({
  name: "Poll",
  payload: ReportExportExecutionInputSchema,
  success: ReportExportPollResultSchema,
  errors: ReportExportOperatorErrorsSchema,
})

const poll = Command.implement(
  pollSpec,
  Effect.fn("ReportExports.Poll")(function* ({ executionId }) {
    const executions = yield* ReportExportExecutionStore
    const found = yield* executions.find(executionId)
    if (Option.isNone(found)) return ReportExportPollResultSchema.make({ _tag: "Unknown" })

    const { value: execution } = found
    const succeeded = sameStatus(execution.status, "succeeded")
    const retainedArtifact = Option.fromNullishOr(execution.artifact)
    const missingArtifact = Option.isNone(retainedArtifact)
    const corruptSuccess = Array.every([succeeded, missingArtifact], Boolean)

    if (corruptSuccess) {
      return yield* nativeUnavailable(`Succeeded execution has no artifact: ${executionId}`)
    }

    const applicationResult = applicationPollResult(execution)
    if (Option.isSome(applicationResult)) return applicationResult.value

    const polling = FinancialReportExport.poll(executionId)
    const result = yield* native(polling)

    if (Option.isNone(result)) {
      return ReportExportPollResultSchema.make({ _tag: "Pending", stage: execution.status })
    }

    return yield* pipe(
      Match.value(result.value),
      Match.tagsExhaustive({
        Suspended: ({ cause }) => {

          const reason = pipe(
            Option.fromNullishOr(cause),
            Option.match({
              onNone: Function.constant("Workflow suspended"),
              onSome: Cause.pretty,
            }),
          )

          const recoverable = ReportExportPollResultSchema.make({ _tag: "Recoverable", reason })
          return Effect.succeed(recoverable)
        },
        Complete: ({ exit }) => Exit.match(exit, {
          onFailure: (cause) => {
            const reason = Cause.pretty(cause)
            const failed = ReportExportPollResultSchema.make({ _tag: "Failed", reason })
            return pipe(executions.fail(executionId, reason), Effect.as(failed))
          },
          onSuccess: (artifact) => {
            const succeeded = ReportExportPollResultSchema.make({ _tag: "Succeeded", ...artifact })
            return pipe(executions.succeed(executionId, artifact), Effect.as(succeeded))
          },
        }),
      }),
    )
  }),
)

const reconcileSpec = ReportOperatorCommand.define({
  name: "Reconcile",
  payload: ReportExportExecutionInputSchema,
  success: ReportArtifactSchema,
  errors: ReportExportOperatorErrorsSchema,
})

const reconcile = Command.implement(
  reconcileSpec,
  Effect.fn("ReportExports.Reconcile")(function* ({ executionId }) {
    const executions = yield* ReportExportExecutionStore
    const execution = yield* executions.require(executionId)
    const succeeded = sameStatus(execution.status, "succeeded")
    const artifact = Option.fromNullishOr(execution.artifact)
    const hasArtifact = Option.isSome(artifact)
    const recoverable = succeeded && hasArtifact

    if (!recoverable) {
      return yield* ReportExportRecoveryRejected.make({ executionId, status: execution.status })
    }

    const retained = Option.getOrThrow(artifact)
    const job = makeReportExportJob(execution.request, executionId, retained.releasedBy)
    return yield* writeReportArtifact(job)
  }),
)

const statusSpec = ReportOperatorCommand.define({
  name: "Status",
  success: ReportExportStatusSchema,
  errors: ReportExportOperatorErrorsSchema,
})

const status = Command.implement(
  statusSpec,
  Effect.fn("ReportExports.Status")(function* () {
    const sharding = yield* Sharding.Sharding
    const storage = yield* RunnerStorage.RunnerStorage

    const clusterSnapshot = Effect.all({
      activeEntities: sharding.activeEntityCount,
      shuttingDown: sharding.isShutdown,
      runners: storage.getRunners,
    })

    const snapshot = yield* native(clusterSnapshot)

    const runners = Array.map(snapshot.runners, ([runner, healthy]) => ReportExportRunnerStatusSchema.make({
      host: runner.address.host,
      port: runner.address.port,
      healthy,
      groups: runner.groups,
      weight: runner.weight,
    }))

    return ReportExportStatusSchema.make({ ...snapshot, runners })
  }),
)

export const ReportExportCommands = Command.bundle(
  generate,
  generateDiscard,
  resume,
  release,
  cancel,
  poll,
  reconcile,
  status,
)

export const ReportExportRpcs = pipe(
  ReportExportCommands.group,
  Function.identity,
)
