import { Array, Context, Effect, Layer, Record, type Scope, Schema, pipe } from "effect"
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

type CommandRpcs<Contracts extends CommandContracts> = {
  readonly [Name in keyof Contracts & string]: CommandRpc<Name, Contracts[Name]>
}[keyof Contracts & string]

type CommandHandlers<Contracts extends CommandContracts, R = never> = {
  readonly [Name in keyof Contracts]: (
    input: Contracts[Name]["input"]["Type"],
  ) => Effect.Effect<
    Contracts[Name]["output"]["Type"],
    Contracts[Name]["error"]["Type"],
    R
  >
}

export interface AnyCommandBundle {
  readonly group: RpcGroup.Any & Pick<RpcGroup.RpcGroup<Rpc.AnyWithProps>, "requests">
  readonly handlers: Layer.Layer<never, any, any>
}

const withCapturedContext = <Contracts extends CommandContracts>(
  captured: Context.Context<any>,
  handlers: CommandHandlers<Contracts, any>,
) => {
  const capture = (handler: CommandHandlers<Contracts, any>[keyof Contracts]) => {
    const invoke = (input: Contracts[keyof Contracts]["input"]["Type"]) =>
      Effect.contextWith((current) => {
        const context = Context.merge(captured, current)
        return pipe(handler(input), Effect.provide(context))
      })

    return invoke
  }

  return Record.map(handlers, capture) as CommandHandlers<Contracts>
}

const toRpcHandlers = <Contracts extends CommandContracts>(handlers: CommandHandlers<Contracts>) =>
  handlers as CommandHandlers<Contracts> & RpcGroup.HandlersFrom<CommandRpcs<Contracts>>

const make = <const Name extends string, const Contracts extends CommandContracts>(
  options: Readonly<{ name: Name; contracts: Contracts }>,
) => {
  const procedure = ([name, contract]: [string, CommandContract]) => {
    const payloadSchema = Schema.toCodecJson(contract.input)
    const successSchema = Schema.toCodecJson(contract.output)
    const errorSchema = Schema.toCodecJson(contract.error)
    return Rpc.make(name, { payload: payloadSchema, success: successSchema, error: errorSchema })
  }

  const procedures = pipe(options.contracts, Record.toEntries, Array.map(procedure)) as Array<CommandRpcs<Contracts>>
  const group = RpcGroup.make(...procedures)

  const handlerLayer = (service: Context.Service<CommandService, CommandHandlers<Contracts>>) =>
    pipe(service, Effect.map(toRpcHandlers<Contracts>), group.toLayer.bind(group))

  class CommandService extends Context.Service<CommandService, CommandHandlers<Contracts>>()(options.name) {
    static readonly group = group

    static readonly handlers = handlerLayer(CommandService) as Layer.Layer<
      Rpc.ToHandler<CommandRpcs<Contracts>>,
      never,
      CommandService
    >

    static layer<Handlers extends CommandHandlers<Contracts, any>, E = never, R = never>(
      value: Handlers | Effect.Effect<Handlers, E, R>,
    ) {
      const construction = Effect.gen(function* () {
        const captured = yield* Effect.context<
          R | RpcGroup.HandlersServices<CommandRpcs<Contracts>, Handlers>
        >()

        const handlers = yield* (Effect.isEffect(value) ? value : Effect.succeed(value))
        return withCapturedContext(captured, handlers)
      })

      return Layer.effect(CommandService)(construction) as Layer.Layer<
        CommandService,
        E,
        Exclude<R, Scope.Scope> | RpcGroup.HandlersServices<CommandRpcs<Contracts>, Handlers>
      >
    }
  }

  return CommandService
}

export const Commands = { make }
