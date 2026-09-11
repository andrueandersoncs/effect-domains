import { Context, Effect, Layer, type Scope } from "effect"
import { RpcClient, type Rpc, type RpcGroup } from "effect/unstable/rpc"
import { makeObjectClient } from "./rpc-in-process.ts"

type Client<Rpcs extends Rpc.Any> = RpcClient.RpcClient<Rpcs>

type InProcessRequirements<Rpcs extends Rpc.Any> =
  | Rpc.ToHandler<Rpcs>
  | Rpc.Middleware<Rpcs>
  | Rpc.MiddlewareClient<Rpcs>

type ProtocolRequirements<Rpcs extends Rpc.Any> = RpcClient.Protocol | Rpc.MiddlewareClient<Rpcs>

const make = <Rpcs extends Rpc.Any>(options: Readonly<{
  name: string
  group: RpcGroup.RpcGroup<Rpcs>
}>) => {
  const protocol = RpcClient.make(options.group) as Effect.Effect<Client<Rpcs>, never, ProtocolRequirements<Rpcs> | Scope.Scope>
  const inProcess = makeObjectClient(options.group) as Effect.Effect<Client<Rpcs>, never, InProcessRequirements<Rpcs> | Scope.Scope>

  class RpcGroupService extends Context.Service<RpcGroupService, Client<Rpcs>>()(options.name) {
    static readonly layerProtocol: Layer.Layer<RpcGroupService, never, ProtocolRequirements<Rpcs>> = Layer.effect(
      RpcGroupService,
      protocol,
    )

    static readonly layer: Layer.Layer<RpcGroupService, never, InProcessRequirements<Rpcs>> = Layer.effect(
      RpcGroupService,
      inProcess,
    )
  }

  return RpcGroupService
}

export type Type<S> = Effect.Services<S>

export const RpcService = { make }
