import { Config, Effect, Equivalence, Layer, Option, Redacted, pipe } from "effect"
import { Headers } from "effect/unstable/http"
import { ClusterWorkflowEngine, ShardingConfig, SingleRunner, SqlRunnerStorage } from "effect/unstable/cluster"
import { PersistedQueue } from "effect/unstable/persistence"
import { DurableQueue } from "effect/unstable/workflow"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { Unauthenticated } from "effect-domains/authorization"
import { ReportArtifactOutput } from "./output.ts"
import { ReportArtifactQueue, FinancialReportExport, executeFinancialReportExport } from "./workflow.ts"
import { writeReportArtifact } from "./writer.ts"

const configuredServices = Effect.gen(function* () {
  const directory = yield* Config.string("REPORT_EXPORTS_OUTPUT_DIR")
  const token = yield* Config.redacted("REPORT_EXPORTS_TOKEN")
  const expectedAuthorization = `Bearer ${Redacted.value(token)}`

  const authenticator = AuthorizationRpc.Authenticator.of({
    authenticate(headers: Headers.Headers) {
      const provided = Headers.get(headers, "authorization")
      const authorized = Option.exists(provided, (value) => Equivalence.strictEqual<string>()(value, expectedAuthorization))

      return authorized
        ? Effect.succeed({ userId: "operator", roles: ["operator"] })
        : Unauthenticated.make({})
    },
  })

  const output = Layer.succeed(ReportArtifactOutput, { directory })
  const authentication = Layer.succeed(AuthorizationRpc.Authenticator, authenticator)
  return Layer.mergeAll(output, authentication)
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
