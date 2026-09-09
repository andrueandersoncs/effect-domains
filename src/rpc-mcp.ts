import { Array, Deferred, Effect, Function, Layer, Option, Schema, Struct, pipe } from "effect"
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai"
import { Headers, type HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { Rpc, RpcClient, RpcGroup, RpcSchema, RpcServer } from "effect/unstable/rpc"

type UnaryRpc = Rpc.Rpc<string, Schema.Top, Schema.Top, Schema.Top>

class RpcMcpDefinitionError extends Schema.TaggedError<RpcMcpDefinitionError>()(
  "RpcMcpDefinitionError",
  { procedure: Schema.String, reason: Schema.String },
) {}

const internalFailure = pipe(McpSchema.CallToolResult.make({
  isError: true,
  content: [{ type: "text", text: "Tool execution failed due to an internal server error." }],
}), Effect.succeed)

const makeClient = Effect.fn("RpcMcp.makeClient")(function* (group: RpcGroup.RpcGroup<UnaryRpc>) {
  type Client = Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<UnaryRpc, never, true>>>
  const ready = yield* Deferred.make<Client>()

  const deliver = (response: Parameters<Client["write"]>[0]) => pipe(
    Deferred.await(ready),
    Effect.flatMap((client) => client.write(response)),
  )

  const server = yield* RpcServer.makeNoSerialization(group, { onFromServer: deliver })

  const client = yield* RpcClient.makeNoSerialization(group, {
    flatten: true,
    onFromClient: ({ message }) => server.write(0, message),
  })

  yield* Deferred.succeed(ready, client)
  return client.client
})

const successResult = (encoded: Schema.JsonObject) => {
  const text = JSON.stringify(encoded)
  return McpSchema.CallToolResult.make({
    isError: false,
    structuredContent: encoded,
    content: [{ type: "text", text }],
  })
}

const errorResult = (text: string) => McpSchema.CallToolResult.make({ isError: true, content: [{ type: "text", text }] })
const failInternally = Function.constant(internalFailure)
const emptyHeaders = () => Headers.empty

const toolSchema = (schema: Schema.Constraint) => pipe(
  Effect.try(() => Tool.getJsonSchemaFromSchema(schema)),
  Effect.flatMap(Schema.decodeUnknownEffect(McpSchema.ToolJsonSchema)),
)

const register = Effect.fn("RpcMcp.register")(function* (group: RpcGroup.RpcGroup<UnaryRpc>) {
  const registry = yield* McpServer.McpServer
  const client = yield* makeClient(group)
  const services = yield* Effect.context<Rpc.ServicesServer<UnaryRpc>>()
  const procedures = group.requests.values()

  yield* Effect.forEach(procedures, Effect.fn("RpcMcp.compileProcedure")(function* (procedure) {
    if (RpcSchema.isStreamSchema(procedure.successSchema)) {
      return yield* RpcMcpDefinitionError.make({ procedure: procedure._tag, reason: "only unary RPC procedures are supported" })
    }
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(procedure._tag)) {
      return yield* RpcMcpDefinitionError.make({ procedure: procedure._tag, reason: "MCP tool names must contain 1–128 letters, digits, underscores, dots, or hyphens" })
    }

    // Envelopes preserve every unary RPC shape because MCP requires object input and output schemas.
    const InputSchema = Schema.Struct({ input: Schema.toCodecJson(procedure.payloadSchema) })
    interface Input extends Schema.Schema.Type<typeof InputSchema> {}
    const OutputSchema = Schema.Struct({ result: Schema.toCodecJson(procedure.successSchema) })
    interface Output extends Schema.Schema.Type<typeof OutputSchema> {}
    const middlewareErrors = pipe(procedure.middlewares, Array.fromIterable, Array.map(Struct.get("error")))
    const ErrorSchema = Schema.fromJsonString(Schema.toCodecJson(Schema.Union([procedure.errorSchema, ...middlewareErrors])))
    const definitionError = (cause: unknown) => RpcMcpDefinitionError.make({ procedure: procedure._tag, reason: String(cause) })
    const inputSchema = yield* pipe(toolSchema(InputSchema), Effect.mapError(definitionError))
    const outputSchema = yield* pipe(toolSchema(OutputSchema), Effect.mapError(definitionError))
    const tool = McpSchema.Tool.make({ name: procedure._tag, inputSchema, outputSchema })

    const execute = Effect.fn("RpcMcp.execute")(function* (arguments_: unknown) {
      const payload: Input = yield* pipe(
        Schema.decodeUnknownEffect(InputSchema)(arguments_),
        Effect.mapError(() => McpSchema.InvalidParams.make({ message: `Invalid arguments for ${procedure._tag}` })),
      )

      const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
      const headers = Option.match(request, { onNone: emptyHeaders, onSome: Struct.get("headers") })

      const failureResponse = (cause: unknown) => pipe(
        Schema.encodeUnknownEffect(ErrorSchema)(cause),
        Effect.map(errorResult),
        Effect.catch(failInternally),
      )

      return yield* pipe(
        client(procedure._tag, payload.input, { headers }),
        Effect.matchEffect({
          onFailure: failureResponse,
          onSuccess: (result) => pipe(
            Schema.encodeUnknownEffect(OutputSchema)({ result }),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject)),
            Effect.map(successResult),
            Effect.catch(failInternally),
          ),
        }),
      )
    })

    yield* registry.addTool({
      tool,
      annotations: procedure.annotations,
      handle: (payload) => pipe(
        execute(payload),
        Effect.provideContext(services),
        Effect.catchDefect(failInternally),
      ),
    })
  }))
})

const layerHttp = <Rpcs extends Rpc.Any>(options: Readonly<{
  name: string
  group: RpcGroup.RpcGroup<Rpcs>
  path: `/${string}`
}>) => {
  const server = McpServer.layerHttp({
    name: options.name,
    version: "0.1.0",
    path: options.path,
    protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
  })

  return pipe(
    register(options.group as RpcGroup.RpcGroup<Rpcs> & RpcGroup.RpcGroup<UnaryRpc>),
    Layer.effectDiscard,
    Layer.provide(server),
  ) as Layer.Layer<
    never,
    RpcMcpDefinitionError | Layer.Error<typeof server>,
    | HttpRouter.HttpRouter
    | Rpc.ToHandler<Rpcs>
    | Rpc.Middleware<Rpcs>
    | Rpc.MiddlewareClient<Rpcs>
    | Rpc.ServicesServer<Rpcs>
  >
}

export const RpcMcp = { layerHttp }
