import { Config, Effect, Layer, Schedule, flow, pipe } from "effect"
import { ClusterWorkflowEngine } from "effect/unstable/cluster"
import { PersistedQueue } from "effect/unstable/persistence"
import { DurableQueue } from "effect/unstable/workflow"
import { clusterRuntimeLayer, clusterWorkerLayer } from "@effect-domains/example-support/cluster-runtime"
import { type ReportExportExecution as ReportExecution, ReportExportExecutionStore } from "./executions.ts"
import { ReportArtifactOutput } from "./output.ts"
import { ReportExportEntitlements } from "./subscriptions.ts"

import {
  executeFinancialReportExport,
  FinancialReportExport,
  ReportArtifactQueue,
  reportExportWorkflowRequest,
} from "./workflow.ts"

import { writeReportArtifact } from "./writer.ts"

const configuredServices = Effect.gen(function* () {
  const directory = yield* Config.string("REPORT_EXPORTS_OUTPUT_DIR")
  const output = Layer.succeed(ReportArtifactOutput, { directory })

  return Layer.mergeAll(output, ReportExportEntitlements)
})

export const ReportExportServices = Layer.unwrap(configuredServices)
const nativeCluster = clusterRuntimeLayer("report-exports", 1)
const workflowEngine = pipe(ClusterWorkflowEngine.layer, Layer.provideMerge(nativeCluster))
const queueStore = PersistedQueue.layerStoreSql({ tableName: "report_export_queue" })
const persistedQueue = pipe(PersistedQueue.layer, Layer.provide(queueStore))
export const ReportExportExecution = Layer.mergeAll(workflowEngine, persistedQueue)

const registration = FinancialReportExport.toLayer(executeFinancialReportExport)

const dispatchExecution = (executions: ReportExportExecutionStore["Service"]) =>
  Effect.fn("ReportExports.dispatchExecution")(function* (execution: ReportExecution) {
    const request = reportExportWorkflowRequest(execution.request, execution.tenantId)
    const dispatched = FinancialReportExport.execute(request, { discard: true })

    yield* pipe(
      dispatched,
      Effect.tap(() => executions.markDispatched(execution.id)),
      Effect.catch((cause) => Effect.logError("Report export outbox dispatch failed", cause)),
    )
  })

const dispatchAccepted = Effect.gen(function* () {
  const executions = yield* ReportExportExecutionStore
  const pending = yield* executions.pending

  yield* Effect.forEach(pending, dispatchExecution(executions), { discard: true })
})

const relaySchedule = Schedule.spaced("1 second")

const relayLoop = pipe(
  dispatchAccepted,
  Effect.catch((cause) => Effect.logError("Report export outbox scan failed", cause)),
  Effect.repeat(relaySchedule),
)

const relayFiber = Effect.forkScoped(relayLoop)
const relay = Layer.effectDiscard(relayFiber)
const writeArtifactJob = flow(writeReportArtifact, Effect.orDie)
const writer = DurableQueue.worker(ReportArtifactQueue, writeArtifactJob, { concurrency: 2 })
const workerLayers = Layer.mergeAll(registration, writer)
const clusterWorkers = clusterWorkerLayer(workerLayers)

export const ReportExportBackground = Layer.mergeAll(relay, clusterWorkers)
