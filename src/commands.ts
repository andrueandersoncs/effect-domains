import { Context, Effect, Layer, Record, type Scope, pipe } from "effect"
import { type Rpc, type RpcGroup } from "effect/unstable/rpc"

type CommandHandlers<Rpcs extends Rpc.Any, R = never> = {
  readonly [Current in Rpcs as Current["_tag"]]: (
    input: Rpc.Payload<Current>,
  ) => Effect.Effect<Rpc.Success<Current>, Rpc.Error<Current>, R>
}

export interface AnyCommandBundle {
  readonly group: RpcGroup.Any & Pick<RpcGroup.RpcGroup<Rpc.AnyWithProps>, "requests">
  readonly handlers: Layer.Layer<never, any, any>
}

const withCapturedContext = <Rpcs extends Rpc.Any>(
  captured: Context.Context<any>,
  handlers: CommandHandlers<Rpcs, any>,
) => {
  const capture = (handler: (input: never) => Effect.Effect<unknown, unknown, unknown>) => {
    const invoke = (input: never) =>
      Effect.contextWith((current: Context.Context<never>) => {
        const context = Context.merge(captured, current)
        return pipe(handler(input), Effect.provide(context))
      })

    return invoke
  }

  return Record.map(handlers, capture) as CommandHandlers<Rpcs>
}

const make = <const Name extends string, Rpcs extends Rpc.Any>(
  options: Readonly<{ name: Name; group: RpcGroup.RpcGroup<Rpcs> }>,
) => {
  const { group } = options

  const rpcHandlers = (handlers: CommandHandlers<Rpcs>) =>
    handlers as CommandHandlers<Rpcs> & RpcGroup.HandlersFrom<Rpcs>

  const handlerLayer = (service: Context.Service<CommandService, CommandHandlers<Rpcs>>) =>
    pipe(service, Effect.map(rpcHandlers), group.toLayer.bind(group))

  class CommandService extends Context.Service<CommandService, CommandHandlers<Rpcs>>()(options.name) {
    static readonly group = group

    static readonly handlers = handlerLayer(CommandService) as Layer.Layer<
      Rpc.ToHandler<Rpcs>,
      never,
      CommandService
    >

    static layer<Handlers extends CommandHandlers<Rpcs, any>, E = never, R = never>(
      value: Handlers | Effect.Effect<Handlers, E, R>,
    ) {
      const construction = Effect.gen(function* () {
        const captured = yield* Effect.context<
          R | RpcGroup.HandlersServices<Rpcs, Handlers>
        >()

        const handlers = yield* (Effect.isEffect(value) ? value : Effect.succeed(value))
        return withCapturedContext<Rpcs>(captured, handlers)
      })

      return Layer.effect(CommandService)(construction) as Layer.Layer<
        CommandService,
        E,
        Exclude<R, Scope.Scope> | RpcGroup.HandlersServices<Rpcs, Handlers>
      >
    }
  }

  return CommandService
}

export const Commands = { make }
