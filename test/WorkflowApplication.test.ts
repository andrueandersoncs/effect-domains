import { expect, it } from "@effect/vitest"
import { Effect, Function, Layer, Ref, Schema, pipe } from "effect"
import { RpcMiddleware, RpcTest } from "effect/unstable/rpc"
import { Headers } from "effect/unstable/http"
import { Workflow, WorkflowEngine, WorkflowProxy, WorkflowProxyServer } from "effect/unstable/workflow"
import { Application } from "effect-domains/application"

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
