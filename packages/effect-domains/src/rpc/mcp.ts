import { Effect, Function, Layer, Option, Schema, Struct, pipe } from "effect"
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai"
import { Headers, HttpServerRequest } from "effect/unstable/http"
import { RpcGroup } from "effect/unstable/rpc"
import type { ApplicationIR } from "../application/index.ts"
import { compileUnaryRpc, type RpcProcedure } from "./contract.ts"
import { inProcessClient } from "./in-process.ts"

class RpcMcpDefinitionError extends Schema.TaggedError<RpcMcpDefinitionError>()(
  "RpcMcpDefinitionError",
  { procedure: Schema.String, reason: Schema.String },
) {}

const internalFailure = McpSchema.CallToolResult.make({
  isError: true,
  content: [{ type: "text", text: "Tool execution failed due to an internal server error." }],
})

const successResult = (encoded: Schema.JsonObject) => McpSchema.CallToolResult.make({
  isError: false,
  structuredContent: encoded,
  content: [{ type: "text", text: JSON.stringify(encoded) }],
})

const errorResult = (text: string) => McpSchema.CallToolResult.make({
  isError: true,
  content: [{ type: "text", text }],
})

const internalFailureEffect = Effect.succeed(internalFailure)
const failInternally = Function.constant(internalFailureEffect)
const emptyHeaders = Function.constant(Headers.empty)

const decodeToolJsonSchema = Schema.decodeUnknownEffect(McpSchema.ToolJsonSchema)

const toolSchema = (schema: Schema.Constraint) => pipe(
  Effect.try(() => Tool.getJsonSchemaFromSchema(schema)),
  Effect.flatMap(decodeToolJsonSchema),
)

const register = Effect.fn("RpcMcp.register")(function* <Rpcs extends RpcProcedure>(group: RpcGroup.RpcGroup<Rpcs>) {
  const registry = yield* McpServer.McpServer
  const procedures = group.requests.values()

  yield* Effect.forEach(procedures, Effect.fn("RpcMcp.compileProcedure")(function* (procedure) {
    const compiled = compileUnaryRpc<RpcProcedure>(procedure)

    const contract = yield* Effect.fromOption(
      compiled,
      () => RpcMcpDefinitionError.make({
        procedure: procedure._tag,
        reason: "only unary RPC procedures are supported",
      }),
    )

    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(contract._tag)) {
      return yield* RpcMcpDefinitionError.make({
        procedure: contract._tag,
        reason: "MCP tool names must contain 1–128 letters, digits, underscores, dots, or hyphens",
      })
    }

    const contractGroup = RpcGroup.make(procedure)
    const { client, withHandlerContext } = yield* inProcessClient(contractGroup)
    const InputSchema = Schema.Struct({ input: contract.payloadSchema })

    interface Input extends Schema.Schema.Type<typeof InputSchema> {}

    const OutputSchema = Schema.Struct({ result: contract.successSchema })

    interface Output extends Schema.Schema.Type<typeof OutputSchema> {}

    const ErrorSchema = Schema.fromJsonString(contract.errorSchema)

    const definitionError = (cause: unknown) => RpcMcpDefinitionError.make({
      procedure: contract._tag,
      reason: String(cause),
    })

    const inputSchema = yield* pipe(toolSchema(InputSchema), Effect.mapError(definitionError))
    const outputSchema = yield* pipe(toolSchema(OutputSchema), Effect.mapError(definitionError))
    const tool = McpSchema.Tool.make({ name: contract._tag, inputSchema, outputSchema })
    const withCodecContext = withHandlerContext(procedure)
    const decodeInput = Schema.decodeUnknownEffect(InputSchema)
    const encodeOutput = Schema.encodeUnknownEffect(OutputSchema)
    const encodeError = Schema.encodeUnknownEffect(ErrorSchema)
    const decodeJsonObject = Schema.decodeUnknownEffect(Schema.JsonObject)

    const failureResponse = (cause: unknown) => pipe(
      encodeError(cause),
      withCodecContext,
      Effect.map(errorResult),
      Effect.catch(failInternally),
    )

    const successResponse = (result: unknown) => pipe(
      OutputSchema.make({ result }),
      encodeOutput,
      withCodecContext,
      Effect.flatMap(decodeJsonObject),
      Effect.map(successResult),
      Effect.catch(failInternally),
    )

    const toolResultFromArguments = Effect.fn("RpcMcp.execute")(function* (
      arguments_: unknown,
      headers: Headers.Headers,
    ) {
      const payload: Input = yield* pipe(
        decodeInput(arguments_),
        withCodecContext,
        Effect.mapError(() => McpSchema.InvalidParams.make({
          message: `Invalid arguments for ${contract._tag}`,
        })),
      )

      const invocation = client(contract._tag, payload.input, { headers })

      return yield* Effect.matchEffect(invocation, {
        onFailure: failureResponse,
        onSuccess: successResponse,
      })
    })

    const handle = Effect.fn("RpcMcp.handle")(function* (payload: unknown) {
      const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)

      const headers = Option.match(request, {
        onNone: emptyHeaders,
        onSome: Struct.get("headers"),
      })

      const result = toolResultFromArguments(payload, headers)

      return yield* Effect.catchDefect(result, failInternally)
    })

    yield* registry.addTool({
      tool,
      annotations: procedure.annotations,
      handle,
    })
  }))
})

export const layerHttp = <App extends ApplicationIR>(options: Readonly<{
  application: App
  path: `/${string}`
}>) => {
  const { application } = options

  const server = McpServer.layerHttp({
    name: application.name,
    version: "0.1.0",
    path: options.path,
    protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
  })

  // SAFETY: The group retains its precise handler requirements because Application.compile assembled these procedures.
  return pipe(
    register<RpcGroup.Rpcs<App["group"]>>(application.group as App["group"] & RpcGroup.RpcGroup<RpcGroup.Rpcs<App["group"]>>),
    Layer.effectDiscard,
    Layer.provide(server),
  )
}

export const RpcMcp = { layerHttp }
