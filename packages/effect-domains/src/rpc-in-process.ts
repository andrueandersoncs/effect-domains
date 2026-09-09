import { Deferred, Effect } from "effect"
import { RpcClient, RpcServer, type Rpc, type RpcGroup } from "effect/unstable/rpc"
import type { Schema } from "effect"

export type UnaryRpc = Rpc.Rpc<string, Schema.Top, Schema.Top, Schema.Top>

export const makeClient = Effect.fn("RpcInProcess.makeClient")(function* (group: RpcGroup.RpcGroup<UnaryRpc>) {
  type Client = Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<UnaryRpc, never, true>>>
  const ready = yield* Deferred.make<Client>()
  const awaitingClient = Deferred.await(ready)

  const deliver = (response: Parameters<Client["write"]>[0]) =>
    Effect.flatMap(awaitingClient, (client) => client.write(response))

  const server = yield* RpcServer.makeNoSerialization(group, { onFromServer: deliver })

  const client = yield* RpcClient.makeNoSerialization(group, {
    flatten: true,
    onFromClient: ({ message }) => server.write(0, message),
  })

  yield* Deferred.succeed(ready, client)
  return client.client
})
