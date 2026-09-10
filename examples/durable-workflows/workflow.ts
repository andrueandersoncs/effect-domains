import { Array, Cause, Effect, Exit, Layer, Match, Option, Schema, pipe } from "effect"
import { ClusterError, RunnerStorage, Sharding } from "effect/unstable/cluster"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Activity, DurableClock, DurableDeferred, DurableQueue, Workflow, WorkflowProxy, WorkflowProxyServer } from "effect/unstable/workflow"
import { AuthorizationSubject } from "effect-domains/authorization"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"

import {
  ApprovalSchema,
  ApproveExportSchema,
  ArtifactSchema,
  ExportJobSchema,
  ExportPollResultSchema,
  ExportRequestSchema,
  PollExportSchema,
  type ExportRequest,
} from "./contracts.ts"

const WorkflowProxyPrefix = "DurableWorkflow."

const groupsSchema = Schema.Array(Schema.String)

class RunnerStatus extends Schema.Class<RunnerStatus>("DurableWorkflowRunnerStatus")({
  host: Schema.String,
  port: Schema.Int,
  healthy: Schema.Boolean,
  groups: groupsSchema,
  weight: Schema.Finite,
}) {}

const runnersSchema = Schema.Array(RunnerStatus)

class WorkflowStatus extends Schema.Class<WorkflowStatus>("DurableWorkflowStatus")({
  activeEntities: Schema.Int,
  shuttingDown: Schema.Boolean,
  runners: runnersSchema,
}) {}

export const DurableExportQueue = DurableQueue.make({
  name: "DurableWorkflows.ExportJson",
  payload: ExportJobSchema,
  success: ArtifactSchema,
  idempotencyKey: ({ executionId }) => executionId,
})

const ExportApproval = DurableDeferred.make("DurableWorkflows.ExportApproval", {
  success: ApprovalSchema,
})

export const DurableExportWorkflow = Workflow.make("Export", {
  payload: ExportRequestSchema,
  success: ArtifactSchema,
  idempotencyKey: ({ exportId }) => exportId,
})


export const executeDurableExport = Effect.fn("DurableWorkflows.Export.execute")(
  function* (request: ExportRequest, executionId: string) {
    yield* DurableClock.sleep({
      name: "DurableWorkflows.BeforeExport",
      duration: "5 seconds",
      inMemoryThreshold: 0,
    })

    if (request.requiresApproval) {
      yield* DurableDeferred.await(ExportApproval)
    }

    const render = Effect.sync(() => ExportJobSchema.make({
      executionId,
      recordCount: request.records.length,
      contents: `${JSON.stringify({ exportId: request.exportId, records: request.records })}\n`,
    }))

    const job = yield* Activity.make({
      name: "DurableWorkflows.ExportJson",
      success: ExportJobSchema,
      execute: render,
    })

    return yield* DurableQueue.process(DurableExportQueue, job)
  },
)

const ApproveExport = Rpc.make("DurableWorkflow.Approve", {
  payload: ApproveExportSchema,
  success: Schema.Void,
})

const PollExport = Rpc.make("DurableWorkflow.Poll", {
  payload: PollExportSchema,
  success: ExportPollResultSchema,
})

const ClusterStatus = Rpc.make("DurableWorkflow.Status", {
  success: WorkflowStatus,
  error: ClusterError.PersistenceError,
})

const nativeProxyGroup = WorkflowProxy.toRpcGroup([DurableExportWorkflow], {
  prefix: WorkflowProxyPrefix,
}).middleware(AuthorizationRpc)

const operatorGroup = RpcGroup.make(ApproveExport, PollExport, ClusterStatus).middleware(AuthorizationRpc)

const operatorHandlers = operatorGroup.toLayer({
  "DurableWorkflow.Approve": Effect.fn("DurableWorkflows.Approve")(function* ({ executionId }) {
    const subject = yield* AuthorizationSubject
    const approvedBy = yield* pipe(Schema.decodeUnknownEffect(Schema.NonEmptyString)(subject["userId"]), Effect.orDie)

    const token = DurableDeferred.tokenFromExecutionId(ExportApproval, {
      workflow: DurableExportWorkflow,
      executionId,
    })

    const value = ApprovalSchema.make({ approvedBy })

    yield* DurableDeferred.succeed(ExportApproval, {
      token,
      value,
    })
  }),
  "DurableWorkflow.Poll": Effect.fn("DurableWorkflows.Poll")(function* ({ executionId }) {
    const result = yield* DurableExportWorkflow.poll(executionId)

    return Option.match(result, {
      onNone: () => ExportPollResultSchema.make({ _tag: "PendingOrUnknown" }),
      onSome: (value) => pipe(Match.value(value), Match.tag("Suspended", () => ExportPollResultSchema.make({ _tag: "PendingOrUnknown" })),
      Match.tag("Complete", ({ exit }) => Exit.isSuccess(exit)
        ? ExportPollResultSchema.make({ _tag: "Succeeded", ...exit.value })
        : ExportPollResultSchema.make({ _tag: "Failed", reason: Cause.pretty(exit.cause) })),
      Match.exhaustive,),
    })
  }),
  "DurableWorkflow.Status": Effect.fn("DurableWorkflows.Status")(function* () {
    const sharding = yield* Sharding.Sharding
    const storage = yield* RunnerStorage.RunnerStorage

    const snapshot = yield* Effect.all({
      activeEntities: sharding.activeEntityCount,
      shuttingDown: sharding.isShutdown,
      runners: storage.getRunners,
    })

    const runners = Array.map(snapshot.runners, ([runner, healthy]) => RunnerStatus.make({
      host: runner.address.host,
      port: runner.address.port,
      healthy,
      groups: runner.groups,
      weight: runner.weight,
    }))

    return WorkflowStatus.make({ ...snapshot, runners })
  }),
})

const proxyHandlers = WorkflowProxyServer.layerRpcHandlers([DurableExportWorkflow], { prefix: WorkflowProxyPrefix })

export const DurableWorkflowCommands = {
  group: nativeProxyGroup.merge(operatorGroup),
  handlers: Layer.merge(proxyHandlers, operatorHandlers),
}
