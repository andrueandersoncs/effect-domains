import { expect, it } from "@effect/vitest"
import { Effect, Equivalence, Exit, Function, Layer, Match, Option, Ref, Schema, pipe } from "effect"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { RpcMiddleware, RpcTest } from "effect/unstable/rpc"
import { Headers } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import { Workflow, WorkflowEngine, WorkflowProxy, WorkflowProxyServer } from "effect/unstable/workflow"
import { Application } from "effect-domains/application"
import { ReportExportRequestSchema } from "../examples/report-exports/contracts.ts"

class OperatorRequired extends Schema.TaggedError<OperatorRequired>()("OperatorRequired", {}) {}

class Operator extends RpcMiddleware.Service<Operator>()("test/WorkflowApplication/Operator", {
  error: OperatorRequired,
}) {}

const operator = Layer.succeed(Operator, Operator.of(
  Effect.fn("WorkflowApplication.authorize")(function* (effect, metadata) {
    if (metadata.headers.authorization !== "Bearer operator") return yield* OperatorRequired.make({})
    return yield* effect
  }),
))

const exportWorkflow = Workflow.make("Export", {
  payload: { requestId: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ requestId }) => requestId,
})

const workflows = [exportWorkflow] as const
const prefix = { prefix: "workflow." } as const
const group = WorkflowProxy.toRpcGroup(workflows, prefix).middleware(Operator)
const proxyHandlers = WorkflowProxyServer.layerRpcHandlers(workflows, prefix)

const workflowModule = Application.make({
  name: "exports",
  parts: [{ group, handlers: proxyHandlers }],
})

const application = Application.make({
  name: "workflow-authorization",
  parts: [workflowModule],
})

it.effect("authorizes native workflow submissions and recovery before invoking the engine", Effect.fn("WorkflowApplication.test")(function* () {
  const executions = yield* Ref.make(0)
  const recordExecution = pipe(Ref.update(executions, (count) => count + 1), Effect.as("exported"))
  const execute = Function.constant(recordExecution)
  const registered = exportWorkflow.toLayer(execute)
  const runtime = pipe(registered, Layer.provideMerge(WorkflowEngine.layerMemory))
  const handlers = pipe(application.handlers, Layer.provide(runtime), Layer.provideMerge(operator))

  yield* pipe(Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(application.group)
    const deniedSubmission = yield* pipe(client["workflow.ExportDiscard"]({ requestId: "one" }), Effect.result)
    expect(deniedSubmission).toMatchObject({ _tag: "Failure", failure: { _tag: "OperatorRequired" } })
    const beforeSubmission = yield* Ref.get(executions)
    expect(beforeSubmission).toBe(0)

    const headers = Headers.fromInput({ authorization: "Bearer operator" })
    const result = yield* client["workflow.Export"]({ requestId: "one" }, { headers })
    expect(result).toBe("exported")
    const executionId = yield* client["workflow.ExportDiscard"]({ requestId: "one" }, { headers })
    const repeatedId = yield* client["workflow.ExportDiscard"]({ requestId: "one" }, { headers })
    expect(repeatedId).toBe(executionId)
    const afterRepeatedSubmission = yield* Ref.get(executions)
    expect(afterRepeatedSubmission).toBe(1)

    const deniedRecovery = yield* pipe(client["workflow.ExportResume"]({ executionId }), Effect.result)
    expect(deniedRecovery).toMatchObject({ _tag: "Failure", failure: { _tag: "OperatorRequired" } })
  }), Effect.provide(handlers), Effect.scoped)
}))

const recoverableWorkflow = Workflow.make("RecoverableExport", {
  payload: { requestId: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ requestId }) => requestId,
}).annotate(Workflow.SuspendOnFailure, true)

it.effect("suspends interrupted workflow failures and resumes the same execution", Effect.fn("WorkflowApplication.recovery")(function* () {
  const attempts = yield* Ref.make(0)

  const get = Effect.fn("WorkflowApplication.get")(function* () {
    const attempt = yield* Ref.getAndUpdate(attempts, (count) => count + 1)
    const firstAttempt = Equivalence.strictEqual<number>()(attempt, 0)

    if (firstAttempt) return yield* Effect.die("simulated runner interruption")

    return "recovered"
  })

  const cluster = pipe(ClusterWorkflowEngine.layer, Layer.provideMerge(TestRunner.layer))
  const runtime = pipe(recoverableWorkflow.toLayer(get), Layer.provideMerge(cluster))

  yield* pipe(Effect.gen(function* () {
    const executionId = yield* recoverableWorkflow.execute({ requestId: "recoverable" }, { discard: true })
    yield* Effect.yieldNow
    yield* TestClock.adjust("100 millis")
    const suspended = yield* recoverableWorkflow.poll(executionId)
    const hasSuspended = Option.isSome(suspended)

    expect(hasSuspended).toBe(true)

    yield* recoverableWorkflow.resume(executionId)
    yield* Effect.yieldNow
    yield* TestClock.adjust("100 millis")
    const completed = yield* recoverableWorkflow.poll(executionId)
    const hasCompleted = Option.isSome(completed)

    expect(hasCompleted).toBe(true)

    if (Option.isNone(completed)) return yield* Effect.die("Workflow result missing after resume")

    const exit = yield* pipe(
      Match.value(completed.value),
      Match.tagsExhaustive({
        Suspended: () => Effect.die("Workflow remained suspended after resume"),
        Complete: ({ exit }) => Effect.succeed(exit),
      }),
    )

    const successful = Exit.isSuccess(exit)

    expect(successful).toBe(true)

    if (!successful) return yield* Effect.die("Workflow completed with a failure after resume")

    const recovered = Equivalence.strictEqual<string>()(exit.value, "recovered")
    const attemptsCount = yield* Ref.get(attempts)

    expect(recovered).toBe(true)
    expect(attemptsCount).toBe(2)
  }), Effect.provide(runtime), Effect.scoped)
}))

const reportExportInputSchema = Schema.toCodecJson(ReportExportRequestSchema)

it.effect("rejects report exports outside supported currencies or an ordered period", Effect.fn("WorkflowApplication.reportExportInput")(function* () {
  const request = yield* Schema.decodeUnknownEffect(reportExportInputSchema)({
    report: {
      reportId: "fy2026-q2",
      reportingPeriod: {
        startsAt: "2026-04-01T00:00:00.000Z",
        endsAt: "2026-06-30T23:59:59.999Z",
      },
      currency: "USD",
      releasePolicy: "automatic",
    },
    lines: [{
      accountCode: "4000",
      description: "Subscription revenue",
      direction: "credit",
      amountMinor: 125000,
    }],
  })

  const unsupportedCurrency = yield* pipe(
    Schema.decodeUnknownEffect(reportExportInputSchema)({
      ...request,
      report: { ...request.report, currency: "ZZZ", reportingPeriod: { startsAt: "2026-04-01T00:00:00.000Z", endsAt: "2026-06-30T23:59:59.999Z" } },
    }),
    Effect.result,
  )

  expect(unsupportedCurrency._tag).toBe("Failure")

  const unorderedPeriod = yield* pipe(
    Schema.decodeUnknownEffect(reportExportInputSchema)({
      ...request,
      report: {
        ...request.report,
        reportingPeriod: {
          startsAt: "2026-06-30T23:59:59.999Z",
          endsAt: "2026-04-01T00:00:00.000Z",
        },
      },
    }),
    Effect.result,
  )

  expect(unorderedPeriod._tag).toBe("Failure")

  const emptyPeriod = yield* pipe(
    Schema.decodeUnknownEffect(reportExportInputSchema)({
      ...request,
      report: {
        ...request.report,
        reportingPeriod: {
          startsAt: "2026-04-01T00:00:00.000Z",
          endsAt: "2026-04-01T00:00:00.000Z",
        },
      },
    }),
    Effect.result,
  )

  expect(emptyPeriod._tag).toBe("Failure")
}))
