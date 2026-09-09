import { Config, Effect, Equivalence, Layer, Option, Redacted, pipe } from "effect"
import { Headers } from "effect/unstable/http"
import { ClusterWorkflowEngine, ShardingConfig, SingleRunner, SqlRunnerStorage } from "effect/unstable/cluster"
import { PersistedQueue } from "effect/unstable/persistence"
import { DurableQueue } from "effect/unstable/workflow"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { Unauthenticated } from "effect-domains/authorization"
import { ExportOutput } from "./output.ts"
import { DurableExportQueue, DurableExportWorkflow, executeDurableExport } from "./workflow.ts"
import { writeExportArtifact } from "./writer.ts"

const configuredServices = Effect.gen(function* () {
  const directory = yield* Config.string("DURABLE_WORKFLOWS_OUTPUT_DIR")
  const token = yield* Config.redacted("DURABLE_WORKFLOWS_TOKEN")
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

  const output = Layer.succeed(ExportOutput, { directory })
  const authentication = Layer.succeed(AuthorizationRpc.Authenticator, authenticator)
  return Layer.mergeAll(output, authentication)
})

export const DurableWorkflowServices = Layer.unwrap(configuredServices)

const shardingConfig = {}

const configuration = ShardingConfig.layerFromEnv(shardingConfig)

const singleRunner = pipe(
  SingleRunner.layer({ shardingConfig }),
  Layer.provideMerge(SqlRunnerStorage.layer),
  Layer.provide(configuration),
)

const workflowEngine = pipe(ClusterWorkflowEngine.layer, Layer.provideMerge(singleRunner),)

const queueStore = PersistedQueue.layerStoreSql({ tableName: "durable_workflow_queue" })
const persistedQueue = pipe(PersistedQueue.layer, Layer.provide(queueStore))

export const DurableWorkflowExecution = Layer.mergeAll(workflowEngine, persistedQueue)

const registration = DurableExportWorkflow.toLayer(executeDurableExport)
const writer = DurableQueue.worker(DurableExportQueue, writeExportArtifact, { concurrency: 2 })
export const DurableWorkflowBackground = Layer.mergeAll(registration, writer)
