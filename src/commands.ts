import { Context, Effect, Layer, type Scope, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

export type CommandContract = Readonly<{
  input: Schema.Top
  output: Schema.Top
  error: Schema.Top
}>

export type CommandContracts = Readonly<Record<string, CommandContract>>

type CommandRpc<Name extends string, Contract extends CommandContract> = Rpc.Rpc<
  Name,
  Schema.toCodecJson<Contract["input"]>,
  Schema.toCodecJson<Contract["output"]>,
  Schema.toCodecJson<Contract["error"]>
>

export type CommandRpcs<Contracts extends CommandContracts> = {
  readonly [Name in keyof Contracts & string]: CommandRpc<Name, Contracts[Name]>
}[keyof Contracts & string]

export type CommandHandlers<Contracts extends CommandContracts, R = never> = {
  readonly [Name in keyof Contracts]: (
    input: Contracts[Name]["input"]["Type"],
  ) => Effect.Effect<
    Contracts[Name]["output"]["Type"],
    Contracts[Name]["error"]["Type"],
    R
  >
}

type CommandGroup<Contracts extends CommandContracts> = RpcGroup.RpcGroup<
  CommandRpcs<Contracts>
>

export interface CommandBundle<
  Name extends string,
  Contracts extends CommandContracts,
> extends Context.Service<CommandBundle<Name, Contracts>, CommandHandlers<Contracts>> {
  readonly name: Name
  readonly contracts: Contracts
  readonly group: CommandGroup<Contracts>
  readonly handlers: Layer.Layer<Rpc.ToHandler<CommandRpcs<Contracts>>, never, CommandBundle<Name, Contracts>>
  readonly layer: <Handlers extends CommandHandlers<Contracts, any>, E = never, R = never>(
    handlers: Handlers | Effect.Effect<Handlers, E, R>,
  ) => Layer.Layer<
    CommandBundle<Name, Contracts>,
    E,
    Exclude<R, Scope.Scope> | RpcGroup.HandlersServices<CommandRpcs<Contracts>, Handlers>
  >
}

export interface AnyCommandBundle {
  readonly group: unknown
  readonly handlers: unknown
}

const withCapturedContext = <Contracts extends CommandContracts>(
  captured: Context.Context<any>,
  handlers: CommandHandlers<Contracts, any>,
): CommandHandlers<Contracts> =>
  Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      (input: unknown) =>
        Effect.contextWith((current) =>
          Effect.provide(handler(input), Context.merge(captured, current))
        ),
    ]),
  ) as CommandHandlers<Contracts>

const toRpcHandlers = <Contracts extends CommandContracts>(
  handlers: CommandHandlers<Contracts>,
): RpcGroup.HandlersFrom<CommandRpcs<Contracts>> =>
  handlers as unknown as RpcGroup.HandlersFrom<CommandRpcs<Contracts>>

const make = <const Name extends string, const Contracts extends CommandContracts>(
  name: Name,
  contracts: Contracts,
): CommandBundle<Name, Contracts> => {
  const procedures = Object.entries(contracts).map(([name, contract]) =>
    Rpc.make(name, {
      payload: Schema.toCodecJson(contract.input),
      success: Schema.toCodecJson(contract.output),
      error: Schema.toCodecJson(contract.error),
    }),
  ) as Array<CommandRpcs<Contracts>>

  const group = RpcGroup.make(...procedures) as CommandGroup<Contracts>
  const service = Context.Service<
    CommandBundle<Name, Contracts>,
    CommandHandlers<Contracts>
  >(name)

  const handlers = group.toLayer(
    Effect.map(service, toRpcHandlers),
  ) as CommandBundle<Name, Contracts>["handlers"]
  const layer = <Handlers extends CommandHandlers<Contracts, any>, E = never, R = never>(
    value: Handlers | Effect.Effect<Handlers, E, R>,
  ): Layer.Layer<
    CommandBundle<Name, Contracts>,
    E,
    Exclude<R, Scope.Scope> | RpcGroup.HandlersServices<CommandRpcs<Contracts>, Handlers>
  > =>
    Layer.effect(service)(
      Effect.gen(function* () {
        const captured = yield* Effect.context<
          R | RpcGroup.HandlersServices<CommandRpcs<Contracts>, Handlers>
        >()
        const handlers = yield* (Effect.isEffect(value) ? value : Effect.succeed(value))
        return withCapturedContext(captured, handlers)
      }),
    ) as Layer.Layer<
      CommandBundle<Name, Contracts>,
      E,
      Exclude<R, Scope.Scope> | RpcGroup.HandlersServices<CommandRpcs<Contracts>, Handlers>
    >

  Object.defineProperty(service, "name", { value: name })
  return Object.assign(service, { contracts, group, handlers, layer }) as CommandBundle<
    Name,
    Contracts
  >
}

export const Commands = { make }
