import { Array, Cause, DateTime, Effect, Equivalence, Exit, Function, Match, Option, Schema, Struct, pipe } from "effect"
import { RunnerStorage, Sharding } from "effect/unstable/cluster"
import { Activity, DurableClock, DurableDeferred, DurableQueue, Workflow } from "effect/unstable/workflow"
import { Operation } from "effect-domains/operation"

import {
  PollReportExportSchema,
  ReportArtifactSchema,
  ReportExportGenerationErrorsSchema,
  ReportExportJobSchema,
  ReportExportOperatorErrorsSchema,
  ReportExportPollResultSchema,
  ReportExportRequestSchema,
  ReportExportRunnerStatusSchema,
  ReportExportStatusSchema,
  ReportExportUnavailable,
  ReportReleaseSchema,
  ReleaseReportSchema,
  type ReportExportRequest,
} from "./contracts.ts"

import { ReportExportGenerationAuthorization } from "./authorization.ts"

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

const workflowRequest = (request: ReportExportRequest, tenantId: string) =>
  WorkflowRequestSchema.make({ ...request, accountId: tenantId })


const selectGenerateDiscard = Effect.fn(
  "ReportExports.selectGenerateDiscard",
)(function* (
  request: ReportExportRequest,
  subject: typeof ExampleSubjectSchema.Type,
) {
  const workflow = workflowRequest(request, subject.tenantId)

  return yield* FinancialReportExport.execute(workflow, { discard: true })
})

const resumeWorkflow = ({ executionId }: typeof PollReportExportSchema.Type) =>
  FinancialReportExport.resume(executionId)

// Call execute as a method because the native workflow reads its payload schema from `this`.
const selectGenerate = Effect.fn("ReportExports.selectGenerate")(function* (
  request: ReportExportRequest,
  subject: typeof ExampleSubjectSchema.Type,
) {
  const workflow = workflowRequest(request, subject.tenantId)
  return yield* FinancialReportExport.execute(workflow)
})

const generate = Operation.make({
  name: "ReportExport.Generate",
  payload: ReportExportRequestSchema,
  success: ReportArtifactSchema,
  handler: selectGenerate,
  errors: ReportExportGenerationErrorsSchema,
  policy: ReportExportGenerationAuthorization,
  unavailable: ReportExportUnavailable,
})

const generateDiscard = Operation.make({
  name: "ReportExport.GenerateDiscard",
  payload: ReportExportRequestSchema,
  success: Schema.String,
  handler: selectGenerateDiscard,
  errors: ReportExportGenerationErrorsSchema,
  policy: ReportExportGenerationAuthorization,
  unavailable: ReportExportUnavailable,
})

const resume = Operation.make({
  name: "ReportExport.GenerateResume",
  payload: PollReportExportSchema,
  success: Schema.Void,
  errors: ReportExportOperatorErrorsSchema,
  policy: ExampleRoles.admin,
  unavailable: ReportExportUnavailable,
  handler: resumeWorkflow,
})

const release = Operation.make({
  name: "ReportExport.Release",
  payload: ReleaseReportSchema,
  success: Schema.Void,
  errors: ReportExportOperatorErrorsSchema,
  policy: ExampleRoles.admin,
  unavailable: ReportExportUnavailable,
  handler: Effect.fn("ReportExports.Release")(function* ({ executionId }, subject) {
    const releasedBy = yield* Schema.decodeUnknownEffect(
      Schema.NonEmptyString,
    )(subject.userId)

    const token = DurableDeferred.tokenFromExecutionId(ReportReleaseApproval, {
      workflow: FinancialReportExport,
      executionId,
    })

    const value = ReportReleaseSchema.make({ releasedBy })
    yield* DurableDeferred.succeed(ReportReleaseApproval, { token, value })
  }),
})

const poll = Operation.make({
  name: "ReportExport.Poll",
  payload: PollReportExportSchema,
  success: ReportExportPollResultSchema,
  errors: ReportExportOperatorErrorsSchema,
  policy: ExampleRoles.admin,
  unavailable: ReportExportUnavailable,
  handler: Effect.fn("ReportExports.Poll")(function* ({ executionId }) {
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
})

const status = Operation.make({
  name: "ReportExport.Status",
  success: ReportExportStatusSchema,
  errors: ReportExportOperatorErrorsSchema,
  policy: ExampleRoles.admin,
  unavailable: ReportExportUnavailable,
  handler: Effect.fn("ReportExports.Status")(function* () {
    const sharding = yield* Sharding.Sharding
    const storage = yield* RunnerStorage.RunnerStorage

    const snapshot = yield* Effect.all({
      activeEntities: sharding.activeEntityCount,
      shuttingDown: sharding.isShutdown,
      runners: storage.getRunners,
    })

    const runners = Array.map(snapshot.runners, ([runner, healthy]) => ReportExportRunnerStatusSchema.make({
      host: runner.address.host,
      port: runner.address.port,
      healthy,
      groups: runner.groups,
      weight: runner.weight,
    }))

    return ReportExportStatusSchema.make({ ...snapshot, runners })
  }),
})

export const ReportExportCommands = Operation.bundle(
  generate,
  generateDiscard,
  resume,
  release,
  poll,
  status,
)

export const ReportExportRpcs = pipe(
  ReportExportCommands.group,
  Function.identity,
)
