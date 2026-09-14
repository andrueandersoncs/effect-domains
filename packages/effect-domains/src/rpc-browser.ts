import { Effect, Equivalence, Layer, Predicate, Record, Schema, pipe } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { Command, Subscription } from "foldkit"
import { FetchHttpClient } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"

import { RequestTokenSchema } from "./requests.ts"

const TaggedErrorSchema = Schema.Struct({ _tag: Schema.String })
const BrowserGlobalSchema = Schema.Struct({ location: Schema.Struct({ href: Schema.String }) })
const HeadersSchema = Schema.Record(Schema.String, Schema.String)
const RequestOptionsSchema = Schema.Struct({ headers: HeadersSchema })
const sameString = Equivalence.strictEqual<string>()

type RequestCommandFieldSchema = globalThis.Record<"request", typeof RequestTokenSchema>

type RequestCommandArgs<Fields extends Schema.Struct.Fields> =
  Schema.Schema.Type<Schema.Struct<Fields & RequestCommandFieldSchema>>

const isNonEmptyString = (value: unknown): value is string =>
  Predicate.isString(value) && value.length > 0

const deepestMessage = (unknownValue: unknown): string | null => {
  if (isNonEmptyString(unknownValue)) return unknownValue
  if (!Predicate.isObject(unknownValue)) return null

  const hasCause = Predicate.hasProperty(unknownValue, "cause")
  const nested = hasCause ? deepestMessage(unknownValue.cause) : null
  if (Predicate.isNotNull(nested)) return nested

  const hasMessage = Predicate.hasProperty(unknownValue, "message")
  if (!hasMessage) return null

  return isNonEmptyString(unknownValue.message) ? unknownValue.message : null
}

const messageFromUnknown = (unknownValue: unknown) => {
  const message = deepestMessage(unknownValue)
  if (Predicate.isNotNull(message)) return message

  return Schema.is(TaggedErrorSchema)(unknownValue) ? unknownValue._tag : String(unknownValue)
}

const makeProtocol = Effect.fn("RpcBrowser.makeProtocol")(function* () {
  const decoded = Schema.decodeUnknownEffect(BrowserGlobalSchema)(globalThis)
  const browserGlobal = yield* pipe(decoded, Effect.orDie)
  const endpoint = new URL("/rpc/v1", browserGlobal.location.href)

  return RpcClient.layerProtocolHttp({ url: endpoint.href })
})

const protocolEffect = makeProtocol()

const protocol = pipe(
  Layer.unwrap(protocolEffect),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerJson),
)

type RpcBrowserClient<I, E, R> = Readonly<{
  layerProtocol: Layer.Layer<I, E, R>
}>

const layer = <I, E, R>(client: RpcBrowserClient<I, E, R>) =>
  pipe(client.layerProtocol, Layer.provide(protocol))

const requestOptions = (token: string | null) => {
  const missing = Predicate.isNull(token)
  if (missing) return RequestOptionsSchema.make({ headers: HeadersSchema.make({}) })

  const empty = sameString(token, "")
  if (empty) return RequestOptionsSchema.make({ headers: HeadersSchema.make({}) })

  return RequestOptionsSchema.make({
    headers: HeadersSchema.make({ authorization: `Bearer ${token}` }),
  })
}

interface BrowserCommandDefinition<
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Failure extends Schema.Top,
  Output,
  Error,
  Requirements,
> {
  readonly args: Fields
  readonly success: Success
  readonly failure: Failure
  readonly execute: (args: RequestCommandArgs<Fields>) => Effect.Effect<Output, Error, Requirements>
  readonly onSuccess: (output: Output, args: RequestCommandArgs<Fields>) => Schema.Schema.Type<Success>
  readonly onFailure: (error: Error, args: RequestCommandArgs<Fields>) => Schema.Schema.Type<Failure>
}

type ReactivityKeys =
  | ReadonlyArray<unknown>
  | Readonly<Record<string, ReadonlyArray<unknown>>>

const resolveReactivityKeys = <Args>(
  keys: ReactivityKeys | ((args: Args) => ReactivityKeys),
  args: Args,
) => Predicate.isFunction(keys) ? keys(args) : keys

interface BrowserMutationDefinition<
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Failure extends Schema.Top,
  Output,
  Error,
  Requirements,
> extends BrowserCommandDefinition<Fields, Success, Failure, Output, Error, Requirements> {
  readonly invalidates: ReactivityKeys | ((args: RequestCommandArgs<Fields>) => ReactivityKeys)
}

interface BrowserQueryDefinition<
  Model,
  Message,
  Fields extends Schema.Struct.Fields,
  Output,
  Error,
  Requirements,
> {
  readonly dependencies: Fields
  readonly modelToDependencies: (model: Model) => Schema.Schema.Type<Schema.Struct<Fields>>
  readonly reactivityKeys:
    | ReactivityKeys
    | ((dependencies: Schema.Schema.Type<Schema.Struct<Fields>>) => ReactivityKeys)
  readonly execute: (
    dependencies: Schema.Schema.Type<Schema.Struct<Fields>>,
  ) => Effect.Effect<Output, Error, Requirements>
  readonly onSuccess: (
    output: Output,
    dependencies: Schema.Schema.Type<Schema.Struct<Fields>>,
  ) => Message
  readonly onFailure: (
    error: Error,
    dependencies: Schema.Schema.Type<Schema.Struct<Fields>>,
  ) => Message
}

const query = <Model, Message>() => <
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Output,
  Error,
  Requirements,
>(
  name: Name,
  definition: BrowserQueryDefinition<Model, Message, Fields, Output, Error, Requirements>,
) => {
  type Dependencies = Schema.Schema.Type<Schema.Struct<Fields>>
  type Services = Requirements | Reactivity.Reactivity

  const dependenciesToStream = (dependencies: Dependencies) => {
    const keys = resolveReactivityKeys(definition.reactivityKeys, dependencies)

    const message = pipe(
      definition.execute(dependencies),
      Effect.match({
        onSuccess: (output) => definition.onSuccess(output, dependencies),
        onFailure: (error) => definition.onFailure(error, dependencies),
      }),
    )

    return Reactivity.stream(message, keys)
  }

  type SubscriptionFactory = ReturnType<typeof Subscription.make<Model, Message, Services>>
  type BuildSubscriptions = Parameters<SubscriptionFactory>[0]

  const buildSubscriptions: BuildSubscriptions = (entry) => {
    const subscription = entry(definition.dependencies, {
      modelToDependencies: definition.modelToDependencies,
      dependenciesToStream,
    })

    return Record.fromEntries([[name, subscription] as const]) as
      Readonly<globalThis.Record<Name, typeof subscription>>
  }

  const subscriptions = Subscription.make<Model, Message, Services>()(buildSubscriptions)

  return subscriptions as Readonly<Record<
    Name,
    Subscription.Subscription<Model, Message, Dependencies, Services>
  >>
}

const command = <
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Failure extends Schema.Top,
  Output,
  Error,
  Requirements,
>(
  name: Name,
  definition: BrowserCommandDefinition<Fields, Success, Failure, Output, Error, Requirements>,
) => {
  const args = Record.set(definition.args, "request", RequestTokenSchema) as
    Fields & globalThis.Record<"request", typeof RequestTokenSchema>

  const execute = (commandArgs: RequestCommandArgs<Fields>) => pipe(
    definition.execute(commandArgs),
    Effect.match({
      onSuccess: (output) => definition.onSuccess(output, commandArgs),
      onFailure: (error) => definition.onFailure(error, commandArgs),
    }),
  )

  const messages = [definition.success, definition.failure] as const
  const config = Object.freeze({ args, messages, execute })

  return Command.define<
    Name,
    Fields & RequestCommandFieldSchema,
    typeof messages,
    ReturnType<typeof execute>
  >(name, config)
}

const mutation = <
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Failure extends Schema.Top,
  Output,
  Error,
  Requirements,
>(
  name: Name,
  definition: BrowserMutationDefinition<Fields, Success, Failure, Output, Error, Requirements>,
) => {
  const args = Record.set(definition.args, "request", RequestTokenSchema) as
    Fields & globalThis.Record<"request", typeof RequestTokenSchema>

  const selectMutation = (commandArgs: RequestCommandArgs<Fields>) => {
    const keys = resolveReactivityKeys(definition.invalidates, commandArgs)
    const effect = definition.execute(commandArgs)
    const mutated = Reactivity.mutation(effect, keys)

    return pipe(
      mutated,
      Effect.match({
        onSuccess: (output) => definition.onSuccess(output, commandArgs),
        onFailure: (error) => definition.onFailure(error, commandArgs),
      }),
    )
  }

  const messages = [definition.success, definition.failure] as const
  const config = Object.freeze({ args, messages, execute: selectMutation })

  return Command.define<
    Name,
    Fields & RequestCommandFieldSchema,
    typeof messages,
    ReturnType<typeof selectMutation>
  >(name, config)
}

export const RpcBrowser = { messageFromUnknown, layer, protocol, requestOptions, command, mutation, query }
