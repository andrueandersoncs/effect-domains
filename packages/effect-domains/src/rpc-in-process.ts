import { Context, Deferred, Effect } from "effect"
import { RpcClient, RpcServer, type Rpc, type RpcGroup } from "effect/unstable/rpc"
import type { Schema } from "effect"

export type UnaryRpc = Rpc.Rpc<string, Schema.Top, Schema.Top, Schema.Top>

export const makeClient = Effect.fn("RpcInProcess.makeClient")(function* (group: RpcGroup.RpcGroup<UnaryRpc>) {
  type ClientRpc = Rpc.Rpc<string, Schema.Codec<unknown>, Schema.Codec<unknown>, Schema.Codec<unknown>>
  type Client = Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<UnaryRpc, never, true>>>
  const handlers = yield* Effect.context<Rpc.ToHandler<UnaryRpc>>()
  const ready = yield* Deferred.make<Client>()
  const awaitingClient = Deferred.await(ready)

  const deliver = (response: Parameters<Client["write"]>[0]) =>
    Effect.flatMap(awaitingClient, (client) => client.write(response))

  const server = yield* RpcServer.makeNoSerialization(group, {
    disableFatalDefects: true,
    onFromServer: deliver,
  })

  // Codec requirements are absent because no-serialization dispatch never executes codecs.
  const client = yield* RpcClient.makeNoSerialization<ClientRpc, never, true>(group as typeof group & RpcGroup.RpcGroup<ClientRpc>, {
    flatten: true,
    onFromClient: ({ message }) => server.write(0, message),
  })

  const withHandlerContext = (rpc: UnaryRpc) => {
    class Handler extends Context.Service<Rpc.Handler<string>, Rpc.Handler<string>>()(rpc.key) {}
    const handler = Context.get(handlers, Handler)

    const provideCodecContext = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
      Effect.provideContext(effect, handler.context as Context.Context<R>)

    return provideCodecContext
  }

  yield* Deferred.succeed(ready, client)
  return { client: client.client, withHandlerContext }
})

export const makeObjectClient = Effect.fn("RpcInProcess.makeObjectClient")(function* <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
) {
  type ClientRpc = Rpc.Rpc<string, Schema.Codec<unknown>, Schema.Codec<unknown>, Schema.Codec<unknown>>
  type Client = Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<UnaryRpc, never, false>>>
  const ready = yield* Deferred.make<Client>()
  const awaitingClient = Deferred.await(ready)

  const deliver = (response: Parameters<Client["write"]>[0]) =>
    Effect.flatMap(awaitingClient, (client) => client.write(response))

  const server = yield* RpcServer.makeNoSerialization(group as RpcGroup.RpcGroup<Rpcs> & RpcGroup.RpcGroup<UnaryRpc>, {
    disableFatalDefects: true,
    onFromServer: deliver,
  })

  const client = yield* RpcClient.makeNoSerialization<ClientRpc, never, false>(
    group as RpcGroup.RpcGroup<Rpcs> & RpcGroup.RpcGroup<ClientRpc>,
    {
      flatten: false,
      onFromClient: ({ message }) => server.write(0, message),
    },
  )

  yield* Deferred.succeed(ready, client)
  return client.client as RpcClient.RpcClient<Rpcs>
})
