import { Config, Effect, Layer, pipe } from "effect"
import { ClusterWorkflowEngine, ShardingConfig, SingleRunner, SqlRunnerStorage } from "effect/unstable/cluster"
import { PersistedQueue } from "effect/unstable/persistence"
import { DurableQueue } from "effect/unstable/workflow"
import { ReportArtifactOutput } from "./output.ts"
import { ReportExportEntitlements } from "./subscriptions.ts"
import { ReportArtifactQueue, FinancialReportExport, executeFinancialReportExport } from "./workflow.ts"
import { writeReportArtifact } from "./writer.ts"

const configuredServices = Effect.gen(function* () {
  const directory = yield* Config.string("REPORT_EXPORTS_OUTPUT_DIR")
  const output = Layer.succeed(ReportArtifactOutput, { directory })
  return Layer.mergeAll(output, ReportExportEntitlements)
})

export const ReportExportServices = Layer.unwrap(configuredServices)
const shardingConfig = {}
const configuration = ShardingConfig.layerFromEnv(shardingConfig)

const singleRunner = pipe(
  SingleRunner.layer({ shardingConfig }),
  Layer.provideMerge(SqlRunnerStorage.layer),
  Layer.provide(configuration),
)

const workflowEngine = pipe(ClusterWorkflowEngine.layer, Layer.provideMerge(singleRunner),)
const queueStore = PersistedQueue.layerStoreSql({ tableName: "report_export_queue" })
const persistedQueue = pipe(PersistedQueue.layer, Layer.provide(queueStore))
export const ReportExportExecution = Layer.mergeAll(workflowEngine, persistedQueue)
const registration = FinancialReportExport.toLayer(executeFinancialReportExport)
const writer = DurableQueue.worker(ReportArtifactQueue, writeReportArtifact, { concurrency: 2 })
export const ReportExportBackground = Layer.mergeAll(registration, writer)
