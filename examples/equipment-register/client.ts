import { BunRuntime } from "@effect/platform-bun"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Config, Console, Effect, Schema, pipe } from "effect"
import { Resource } from "effect-domains/resource"
import { AssetsResource } from "./resources.ts"

const assetsTable = Resource.table(AssetsResource)
const CreatedAssetSchema = Schema.Struct({ result: assetsTable.rowSchema })

interface CreatedAsset extends Schema.Schema.Type<typeof CreatedAssetSchema> {}

class WalkthroughError extends Schema.TaggedError<WalkthroughError>()("WalkthroughError", { message: Schema.String }) {}

const makeClient = Effect.sync(() => new Client({ name: "equipment-register-walkthrough", version: "1.0.0" }))
const closeClient = (client: Client) => Effect.promise(() => client.close())

const call = Effect.fn("EquipmentRegister.call")(function* (client: Client, name: string, input: Schema.Json) {
  const result = yield* Effect.tryPromise(() => client.callTool({ name, arguments: { input } }))
  const json = JSON.stringify(result)

  yield* Console.log(name, json)

  if (result.isError) return yield* WalkthroughError.make({ message: `MCP tool ${name} failed` })

  return result
})

const program = Effect.gen(function* () {
  const url = yield* pipe(Config.string("EQUIPMENT_REGISTER_MCP_URL"), Config.withDefault("http://127.0.0.1:3000/mcp"))
  const client = yield* Effect.acquireRelease(makeClient, closeClient)
  const endpoint = yield* Effect.try(() => new URL(url))
  const transport = yield* Effect.try(() => new StreamableHTTPClientTransport(endpoint))

  yield* Effect.tryPromise(() => client.connect(transport))

  const server = pipe(client.getServerVersion(), JSON.stringify)

  yield* Console.log("Connected", server)

  const tools = yield* Effect.tryPromise(() => client.listTools())
  const discovery = JSON.stringify(tools, null, 2)

  yield* Console.log("tools/list", discovery)

  const created = yield* call(client, "assets.create", {
    assetTag: "EQ-CAM2048",
    name: "Field camera",
    model: "X100V",
    serial: "FJ2-2025-0042",
    location: "Studio A",
    condition: "in-service",
  })

  const { result: asset } = yield* Schema.decodeUnknownEffect(CreatedAssetSchema)(created.structuredContent)

  yield* call(client, "assets.get", { id: asset.id })

  const movedResult = yield* call(client, "assets.update", { ...asset, location: "Editorial desk" })
  const { result: moved } = yield* Schema.decodeUnknownEffect(CreatedAssetSchema)(movedResult.structuredContent)

  yield* call(client, "assets.list", { filter: { location: moved.location, condition: "in-service" } })
  yield* call(client, "assets.update", { ...moved, condition: "retired" })
  yield* call(client, "assets.remove", { id: asset.id })

  const missing = yield* Effect.tryPromise(() => client.callTool({ name: "assets.get", arguments: { input: { id: asset.id } } }))
  const failure = JSON.stringify(missing)

  yield* Console.log("assets.get after removal (expected ResourceNotFound)", failure)

  const successfulResult = !missing.isError
  const wrongError = !failure.includes("ResourceNotFound")
  const unexpectedResult = successfulResult || wrongError

  if (unexpectedResult) {
    return yield* WalkthroughError.make({ message: "Expected the declared ResourceNotFound tool error" })
  }

  yield* Effect.tryPromise(() => transport.terminateSession())
})

pipe(program, Effect.scoped, BunRuntime.runMain)
