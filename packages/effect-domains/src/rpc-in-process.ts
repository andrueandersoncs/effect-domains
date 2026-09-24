import { Context, Deferred, Effect } from "effect"
import { RpcClient, RpcServer, type Rpc, type RpcGroup } from "effect/unstable/rpc"
import type { Schema } from "effect"

export type UnaryRpc = Rpc.Rpc<string, Schema.Top, Schema.Top, Schema.Top>

export const inProcessClient = Effect.fn("RpcInProcess.makeClient")(function* <Rpcs extends UnaryRpc>(
  group: RpcGroup.RpcGroup<Rpcs>,
) {
  type ClientRpc = Rpc.Rpc<string, Schema.Codec<unknown>, Schema.Codec<unknown>, Schema.Codec<unknown>>
  type PublicClient = Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<ClientRpc, never, true>>>
  type Client = Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<Rpcs, never, true>>>

  const handlers = yield* Effect.context<Rpc.ToHandler<Rpcs>>()
  const ready = yield* Deferred.make<Client>()
  const awaitingClient = Deferred.await(ready)

  const deliver = (response: Parameters<Client["write"]>[0]) =>
    Effect.flatMap(awaitingClient, (client) => client.write(response))

  const server = yield* RpcServer.makeNoSerialization(group, {
    disableFatalDefects: true,
    onFromServer: deliver,
  })

  const client = yield* RpcClient.makeNoSerialization<Rpcs, never, true>(group, {
    flatten: true,
    onFromClient: ({ message }) => server.write(0, message),
  })

  const withHandlerContext = (rpc: Rpcs) => {
    class Handler extends Context.Service<Rpc.Handler<string>, Rpc.Handler<string>>()(rpc.key) {}

    // SAFETY: The cast is valid because RpcServer derives ToHandler<Rpcs> from the same keyed RPC group.
    const handler = Context.get(handlers as Context.Context<Rpc.Handler<string>>, Handler)

    const provideCodecContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      // SAFETY: This context satisfies R because it belongs to the matching handler and codecs.
      Effect.provideContext(effect, handler.context as Context.Context<R>)

    return provideCodecContext
  }

  yield* Deferred.succeed(ready, client)

  // SAFETY: The intersection is valid because no-serialization dispatch never executes either client's codecs.
  return { client: client.client as PublicClient["client"] & typeof client.client, withHandlerContext }
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

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const server = yield* RpcServer.makeNoSerialization(group as RpcGroup.RpcGroup<Rpcs> & RpcGroup.RpcGroup<UnaryRpc>, {
    disableFatalDefects: true,
    onFromServer: deliver,
  })

  const client = yield* RpcClient.makeNoSerialization<ClientRpc, never, false>(
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    group as RpcGroup.RpcGroup<Rpcs> & RpcGroup.RpcGroup<ClientRpc>,
    {
      flatten: false,
      onFromClient: ({ message }) => server.write(0, message),
    },
  )

  yield* Deferred.succeed(ready, client)

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  return client.client as RpcClient.RpcClient<Rpcs>
})
