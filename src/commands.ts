import { Context, Effect, Layer, Option, Record, Schema, type Scope, pipe } from "effect"
import { Rpc, type RpcGroup } from "effect/unstable/rpc"

type CommandHandlerDefinitions<Rpcs extends Rpc.Any> = {
  readonly [Current in Rpcs as Current["_tag"]]: (
    input: Rpc.Payload<Current>,
  ) => Effect.Effect<any, any, any>
}

type CommandHandlers<Rpcs extends Rpc.Any, R = never> = {
  readonly [Current in Rpcs as Current["_tag"]]: (
    input: Rpc.Payload<Current>,
  ) => Effect.Effect<Rpc.Success<Current>, Rpc.Error<Current>, R>
}

type HandlerEffect<Handler> = Handler extends (...args: ReadonlyArray<any>) => infer Result
  ? Result extends Effect.Effect<any, any, any>
    ? Result
    : never
  : never

type HandlerEffects<Handlers> = HandlerEffect<Handlers[keyof Handlers]>
type TaggedErrors<Effect_> = Extract<Effect.Error<Effect_>, { readonly _tag: string }>
type ErrorTags<Effect_> = TaggedErrors<Effect_>["_tag"]

type CatchTagHandlers<Handlers> = Partial<{
  readonly [Tag in ErrorTags<HandlerEffects<Handlers>>]: (
    error: Extract<TaggedErrors<HandlerEffects<Handlers>>, { readonly _tag: Tag }>,
  ) => Effect.Effect<any, any, any>
}>

type RequiredCatchTagKeys<CatchTags> = {
  readonly [Key in keyof CatchTags]-?: {} extends Pick<CatchTags, Key>
    ? never
    : CatchTags[Key] extends (...args: ReadonlyArray<any>) => Effect.Effect<any, any, any>
      ? Key
      : never
}[keyof CatchTags]

type SelectedCatchTagEffects<Effect_, CatchTags> = HandlerEffect<
  CatchTags[Extract<RequiredCatchTagKeys<CatchTags>, ErrorTags<Effect_>>]
>

type InvocationSuccess<Effect_, CatchTags> =
  | Effect.Success<Effect_>
  | Effect.Success<SelectedCatchTagEffects<Effect_, CatchTags>>

type InvocationError<Effect_, CatchTags> =
  | Exclude<
    Effect.Error<Effect_>,
    { readonly _tag: Extract<RequiredCatchTagKeys<CatchTags>, string> }
  >
  | Effect.Error<SelectedCatchTagEffects<Effect_, CatchTags>>

type CatchTagServices<CatchTags> = Effect.Services<HandlerEffect<CatchTags[keyof CatchTags]>>

type HandlerIsValid<Current extends Rpc.Any, Handler, CatchTags> =
  Handler extends Effect.Effect<any, any, any>
    ? [InvocationSuccess<Handler, CatchTags>] extends [Rpc.Success<Current>]
      ? [InvocationError<Handler, CatchTags>] extends [Rpc.Error<Current>]
        ? true
        : false
      : false
    : false

type InvalidHandlerTags<Rpcs extends Rpc.Any, Handlers, CatchTags> = {
  readonly [Current in Rpcs as Current["_tag"]]: HandlerIsValid<
    Current,
    HandlerEffect<Handlers[Current["_tag"] & keyof Handlers]>,
    CatchTags
  > extends true
    ? never
    : Current["_tag"]
}[Rpcs["_tag"]]

type ValidHandlers<Rpcs extends Rpc.Any, Handlers, CatchTags> =
  [InvalidHandlerTags<Rpcs, Handlers, CatchTags>] extends [never] ? unknown : never

type ValidCatchTags<Handlers, CatchTags> =
  Exclude<keyof CatchTags, ErrorTags<HandlerEffects<Handlers>>> extends never ? unknown : never

type LayerOptions<Handlers, CatchTags> = Readonly<Partial<{
  readonly catchTags: CatchTags
}>> & ValidCatchTags<Handlers, CatchTags>

export interface AnyCommandBundle {
  readonly group: RpcGroup.Any & Pick<RpcGroup.RpcGroup<Rpc.AnyWithProps>, "requests">
  readonly handlers: Layer.Layer<never, any, any>
}

const withCapturedContext = <
  Rpcs extends Rpc.Any,
  Handlers extends CommandHandlerDefinitions<Rpcs>,
  CatchTags extends CatchTagHandlers<Handlers>,
>(
  captured: Context.Context<any>,
  handlers: Handlers,
  catchTags: Option.Option<CatchTags>,
) => {
  const capture = (handler: (input: never) => Effect.Effect<any, any, any>) => {
    const invoke = (input: never) =>
      Effect.contextWith((current: Context.Context<never>) => {
        const context = Context.merge(captured, current)
        const invocation = Option.isNone(catchTags)
          ? handler(input)
          : pipe(handler(input), Effect.catchTags(catchTags.value))
        return pipe(invocation, Effect.provide(context))
      })

    return invoke
  }

  return Record.map(handlers, capture) as CommandHandlers<Rpcs>
}

const rpc = <
  const Tag extends string,
  Payload extends Schema.Constraint,
  Success extends Schema.Constraint,
  Error extends Schema.Constraint,
>(
  tag: Tag,
  options: Readonly<{ payload: Payload; success: Success; error: Error }>,
) => {
  const payloadSchema = Schema.toCodecJson(options.payload)
  const successSchema = Schema.toCodecJson(options.success)
  const errorSchema = Schema.toCodecJson(options.error)
  return Rpc.make(tag, { payload: payloadSchema, success: successSchema, error: errorSchema })
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

    static layer<
      Handlers extends CommandHandlerDefinitions<Rpcs>,
      E = never,
      R = never,
      CatchTags extends CatchTagHandlers<Handlers> = {},
    >(
      value: (
        Handlers & ValidHandlers<Rpcs, Handlers, CatchTags>
      ) | Effect.Effect<Handlers & ValidHandlers<Rpcs, Handlers, CatchTags>, E, R>,
      options?: LayerOptions<Handlers, CatchTags>,
    ) {
      const construction = Effect.gen(function* () {
        const captured = yield* Effect.context<
          R | RpcGroup.HandlersServices<Rpcs, Handlers> | CatchTagServices<CatchTags>
        >()

        const handlers = yield* (Effect.isEffect(value) ? value : Effect.succeed(value))
        const catchTags = Option.fromNullishOr(options?.catchTags)
        return withCapturedContext<Rpcs, Handlers, CatchTags>(
          captured,
          handlers,
          catchTags,
        )
      })

      return Layer.effect(CommandService)(construction) as Layer.Layer<
        CommandService,
        E,
        | Exclude<R, Scope.Scope>
        | RpcGroup.HandlersServices<Rpcs, Handlers>
        | CatchTagServices<CatchTags>
      >
    }
  }

  return CommandService
}

export const Commands = { make, rpc }
