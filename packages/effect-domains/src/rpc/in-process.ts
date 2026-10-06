import { Context, Deferred, Effect } from "effect"
import { RpcClient, RpcServer, type Rpc, type RpcGroup } from "effect/unstable/rpc"
import type { Schema } from "effect"

const deliverServerResponses = <
  Message,
  Client extends { readonly write: (message: Message) => Effect.Effect<void> },
>(ready: Deferred.Deferred<Client>) => {
  const connectedClient = Deferred.await(ready)

  const deliver = (response: Message) =>
    Effect.flatMap(connectedClient, (client) => client.write(response))

  return deliver
}

export const inProcessClient = Effect.fn("RpcInProcess.makeClient")(function* <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
) {
  type ClientRpc = Rpc.Rpc<string, Schema.Codec<unknown>, Schema.Codec<unknown>, Schema.Codec<unknown>>
  type PublicClient = Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<ClientRpc, never, true>>>
  type Client = Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<Rpcs, never, true>>>

  const handlers = yield* Effect.context<Rpc.ToHandler<Rpcs>>()
  const ready = yield* Deferred.make<Client>()
  const deliver = deliverServerResponses<Parameters<Client["write"]>[0], Client>(ready)

  const server = yield* RpcServer.makeNoSerialization(group, {
    disableFatalDefects: true,
    onFromServer: deliver,
  })

  const client = yield* RpcClient.makeNoSerialization<Rpcs, never, true>(group, {
    flatten: true,
    onFromClient: ({ message }) => server.write(0, message),
  })

  const withHandlerContext = (rpc: Rpc.Any) => {
    class Handler extends Context.Service<Rpc.Handler<string>, Rpc.Handler<string>>()(rpc.key) {}

    // SAFETY: The handler lookup uses this group's RPC key because the server was built from the same group.
    const handler = Context.get(handlers as Context.Context<Rpc.Handler<string>>, Handler)

    const provideCodecContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      // SAFETY: This context satisfies R because it belongs to the matching handler and codecs.
      Effect.provideContext(effect, handler.context as Context.Context<R>)

    return provideCodecContext
  }

  yield* Deferred.succeed(ready, client)

  // SAFETY: Dispatch is valid because this transport never executes client codecs.
  const { client: dispatch }: Pick<PublicClient, "client"> = client as typeof client & Pick<PublicClient, "client">

  return { client: dispatch, withHandlerContext }
})

