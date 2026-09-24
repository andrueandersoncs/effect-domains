import { Effect, Function, Layer, Option, Schema, Struct, pipe } from "effect"
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai"
import { Headers, type HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import type { ApplicationIR } from "./application.ts"
import { compileUnaryRpc } from "./rpc-contract.ts"
import { inProcessClient, type UnaryRpc } from "./rpc-in-process.ts"

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

const register = Effect.fn("RpcMcp.register")(function* (group: ApplicationIR["group"]) {
  const registry = yield* McpServer.McpServer
  const procedures = group.requests.values()

  yield* Effect.forEach(procedures, Effect.fn("RpcMcp.compileProcedure")(function* (procedure) {
    const compiled = compileUnaryRpc(procedure)

    const contract = yield* Effect.fromOption(
      compiled,
      () => RpcMcpDefinitionError.make({
        procedure: procedure._tag,
        reason: "only unary RPC procedures are supported",
      }),
    )

    // SAFETY: The cast is valid because compileUnaryRpc rejected streaming success schemas for this original procedure.
    const contractGroup = RpcGroup.make(procedure as UnaryRpc)
    const { client, withHandlerContext } = yield* inProcessClient(contractGroup)

    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(contract._tag)) {
      return yield* RpcMcpDefinitionError.make({
        procedure: contract._tag,
        reason: "MCP tool names must contain 1–128 letters, digits, underscores, dots, or hyphens",
      })
    }

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
    const withCodecContext = withHandlerContext(contract)

    const toolResultFromArguments = Effect.fn("RpcMcp.execute")(function* (
      arguments_: unknown,
      headers: Headers.Headers,
    ) {
      const decodeInput = Schema.decodeUnknownEffect(InputSchema)

      const payload: Input = yield* pipe(
        decodeInput(arguments_),
        withCodecContext,
        Effect.mapError(() => McpSchema.InvalidParams.make({
          message: `Invalid arguments for ${contract._tag}`,
        })),
      )

      const failureResponse = (cause: unknown) => pipe(
        Schema.encodeUnknownEffect(ErrorSchema)(cause),
        withCodecContext,
        Effect.map(errorResult),
        Effect.catch(failInternally),
      )

      const encodeOutput = Schema.encodeUnknownEffect(OutputSchema)
      const invokeClient = (input: Input["input"]) => client(contract._tag, input, { headers })
      const invocation = invokeClient(payload.input)

      return yield* pipe(
        invocation,
        Effect.matchEffect({
          onFailure: failureResponse,
          onSuccess: (result) => pipe(
            OutputSchema.make({ result }),
            encodeOutput,
            withCodecContext,
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject)),
            Effect.map(successResult),
            Effect.catch(failInternally),
          ),
        }),
      )
    })

    const handle = Effect.fn("RpcMcp.handle")(function* (payload: unknown) {
      const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)

      const headers = Option.match(request, {
        onNone: emptyHeaders,
        onSome: Struct.get("headers"),
      })

      return yield* pipe(
        toolResultFromArguments(payload, headers),
        Effect.catchDefect(failInternally),
      )
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

  const registration = register(application.group)

  return pipe(
    registration,
    Layer.effectDiscard,
    Layer.provide(server),
  )
}

export const RpcMcp = { layerHttp }
