import { BunRuntime } from "@effect/platform-bun"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Config, Console, Effect, Schema, pipe } from "effect"
import { BookResource } from "./resources.ts"

const CreatedBookSchema = Schema.Struct({ result: BookResource.table.rowSchema })
interface CreatedBook extends Schema.Schema.Type<typeof CreatedBookSchema> {}

class WalkthroughError extends Schema.TaggedError<WalkthroughError>()("WalkthroughError", { message: Schema.String }) {}

const makeClient = Effect.sync(() => new Client({ name: "effect-domains-example", version: "1.0.0" }))
const closeClient = (client: Client) => Effect.promise(() => client.close())

const call = Effect.fn("McpExample.call")(function* (client: Client, name: string, input: Schema.Json) {
  const result = yield* Effect.tryPromise(() => client.callTool({ name, arguments: { input } }))
  const json = JSON.stringify(result)
  yield* Console.log(name, json)
  if (result.isError) return yield* WalkthroughError.make({ message: `MCP tool ${name} failed` })
  return result
})

const program = Effect.gen(function* () {
  const url = yield* pipe(Config.string("MCP_SERVER_MCP_URL"), Config.withDefault("http://127.0.0.1:3000/mcp"))
  const client = yield* Effect.acquireRelease(makeClient, closeClient)
  const endpoint = yield* Effect.try(() => new URL(url))
  const transport = yield* Effect.try(() => new StreamableHTTPClientTransport(endpoint))

  yield* Effect.tryPromise(() => client.connect(transport))
  const server = pipe(client.getServerVersion(), JSON.stringify)
  yield* Console.log("Connected", server)
  const tools = yield* Effect.tryPromise(() => client.listTools())
  const discovery = JSON.stringify(tools, null, 2)
  yield* Console.log("tools/list", discovery)

  const created = yield* call(client, "books.create", { title: "MCP Field Guide", pageCount: 120 })
  const { result: book } = yield* Schema.decodeUnknownEffect(CreatedBookSchema)(created.structuredContent)
  yield* call(client, "books.get", { id: book.id })
  yield* call(client, "books.update", { ...book, title: "MCP Field Guide, revised", pageCount: 144 })
  yield* call(client, "books.list", {})
  yield* call(client, "books.remove", { id: book.id })

  const missing = yield* Effect.tryPromise(() => client.callTool({ name: "books.get", arguments: { input: { id: book.id } } }))
  const failure = JSON.stringify(missing)
  yield* Console.log("books.get after removal (expected error)", failure)
  if (!missing.isError) return yield* WalkthroughError.make({ message: "Expected a missing-book tool error" })

  yield* Effect.tryPromise(() => transport.terminateSession())
})

pipe(program, Effect.scoped, BunRuntime.runMain)
