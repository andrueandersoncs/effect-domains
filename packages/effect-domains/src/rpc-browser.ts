import { Effect, Equivalence, Layer, Predicate, Record, Schema, pipe } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { Command, Subscription } from "foldkit"
import { FetchHttpClient } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"

import { RequestTokenSchema, type RequestToken } from "./requests.ts"

const TaggedErrorSchema = Schema.Struct({ _tag: Schema.String })
const BrowserGlobalSchema = Schema.Struct({ location: Schema.Struct({ href: Schema.String }) })
const HeadersSchema = Schema.Record(Schema.String, Schema.String)
const RequestOptionsSchema = Schema.Struct({ headers: HeadersSchema })
const StandardFailureFieldsSchema = Schema.Struct({ error: Schema.String })
const sameString = Equivalence.strictEqual<string>()

type RequestCommandFieldSchema = globalThis.Record<"request", typeof RequestTokenSchema>

type RequestCommandArgs<Fields extends Schema.Struct.Fields> =
  Schema.Schema.Type<Schema.Struct<Fields>> & Readonly<{ request: RequestToken }>

type MessageConstructor<Output = unknown> = Schema.Top & Readonly<{
  make: (value: never) => Output
}>

type MessageInput<Constructor extends MessageConstructor> =
  Parameters<Constructor["make"]>[0]

type MessageOutput<Constructor extends MessageConstructor> =
  Schema.Schema.Type<Constructor>

type MessagePayload<Constructor extends MessageConstructor> =
  Omit<MessageInput<Constructor>, "_tag" | "request">

type QueryMessagePayload<Constructor extends MessageConstructor> =
  Omit<MessageInput<Constructor>, "_tag">

type CustomFailurePayload<
  Constructor extends MessageConstructor,
  Error,
  Args,
> = Readonly<{
  failurePayload: (error: Error, args: Args) => MessagePayload<Constructor>
}>

type CustomErrorFormat<Error> = Readonly<{
  formatError: (error: Error) => string
}>

type StandardFailureHandling<
  Constructor extends MessageConstructor,
  Error,
  Args,
> =
  | Readonly<Record<never, never>>
  | CustomErrorFormat<Error>
  | CustomFailurePayload<Constructor, Error, Args>

type FailureHandling<
  Constructor extends MessageConstructor,
  Error,
  Args,
> = Readonly<{ error: string }> extends MessagePayload<Constructor>
  ? StandardFailureHandling<Constructor, Error, Args>
  : CustomFailurePayload<Constructor, Error, Args>

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

const resolveFailureFields = <
  Constructor extends MessageConstructor,
  Error,
  Args,
>(
  definition: FailureHandling<Constructor, Error, Args>,
  error: Error,
  args: Args,
): Readonly<Record<string, unknown>> => {
  const hasCustomPayload = "failurePayload" in definition
    && Predicate.isFunction(definition.failurePayload)

  if (hasCustomPayload) {
    return definition.failurePayload(error, args) as Readonly<Record<string, unknown>>
  }

  const errorMessage = "formatError" in definition
    ? definition.formatError(error)
    : messageFromUnknown(error)

  return StandardFailureFieldsSchema.make({ error: errorMessage })
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

type BrowserCommandDefinition<
  Fields extends Schema.Struct.Fields,
  Success extends MessageConstructor,
  Failure extends MessageConstructor,
  Error,
  Requirements,
> = Readonly<{
  args: Fields
  success: Success
  failure: Failure
  execute: (
    args: RequestCommandArgs<Fields>,
  ) => Effect.Effect<MessagePayload<Success>, Error, Requirements>
}> & FailureHandling<Failure, Error, RequestCommandArgs<Fields>>

type ReactivityKeys =
  | ReadonlyArray<unknown>
  | Readonly<Record<string, ReadonlyArray<unknown>>>

const resolveReactivityKeys = <Args>(
  keys: ReactivityKeys | ((args: Args) => ReactivityKeys),
  args: Args,
) => Predicate.isFunction(keys) ? keys(args) : keys

type BrowserMutationDefinition<
  Fields extends Schema.Struct.Fields,
  Success extends MessageConstructor,
  Failure extends MessageConstructor,
  Error,
  Requirements,
> = BrowserCommandDefinition<Fields, Success, Failure, Error, Requirements> & Readonly<{
  invalidates: ReactivityKeys | ((args: RequestCommandArgs<Fields>) => ReactivityKeys)
}>

type BrowserQueryDefinition<
  Model,
  Fields extends Schema.Struct.Fields,
  Success extends MessageConstructor,
  Failure extends MessageConstructor,
  Error,
  Requirements,
> = Readonly<{
  dependencies: Fields
  modelToDependencies: (model: Model) => Schema.Schema.Type<Schema.Struct<Fields>>
  reactivityKeys:
    | ReactivityKeys
    | ((dependencies: Schema.Schema.Type<Schema.Struct<Fields>>) => ReactivityKeys)
  execute: (
    dependencies: Schema.Schema.Type<Schema.Struct<Fields>>,
  ) => Effect.Effect<QueryMessagePayload<Success>, Error, Requirements>
  success: Success
  failure: Failure
}> & FailureHandling<Failure, Error, Schema.Schema.Type<Schema.Struct<Fields>>>

const query = <Model, Message>() => <
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends MessageConstructor,
  Failure extends MessageConstructor,
  Error,
  Requirements,
>(
  name: Name,
  definition: BrowserQueryDefinition<Model, Fields, Success, Failure, Error, Requirements>,
) => {
  type Dependencies = Schema.Schema.Type<Schema.Struct<Fields>>
  type Services = Requirements | Reactivity.Reactivity

  const dependenciesToStream = (dependencies: Dependencies) => {
    const keys = resolveReactivityKeys(definition.reactivityKeys, dependencies)

    const result = pipe(
      definition.execute(dependencies),
      Effect.match({
        onSuccess: definition.success.make.bind(definition.success) as
          (payload: QueryMessagePayload<Success>) => MessageOutput<Success>,
        onFailure: (error) => pipe(
          resolveFailureFields(definition, error, dependencies),
          definition.failure.make.bind(definition.failure) as
            (fields: Readonly<Record<string, unknown>>) => MessageOutput<Failure>,
        ),
      }),
    )

    return Reactivity.stream(
      result as Effect.Effect<Message, never, Requirements>,
      keys,
    )
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
  Success extends MessageConstructor,
  Failure extends MessageConstructor,
  Error,
  Requirements,
>(
  name: Name,
  definition: BrowserCommandDefinition<Fields, Success, Failure, Error, Requirements>,
) => {
  const args = Record.set(definition.args, "request", RequestTokenSchema) as
    Fields & globalThis.Record<"request", typeof RequestTokenSchema>

  type RuntimeArgs = Schema.Schema.Type<Schema.Struct<typeof args>>

  const constructResult = (runtimeArgs: RuntimeArgs) => pipe(
    definition.execute(runtimeArgs as RequestCommandArgs<Fields>),
    Effect.match({
      onSuccess: (payload) => definition.success.make({
        ...payload,
        request: (runtimeArgs as RequestCommandArgs<Fields>).request,
      } as never) as MessageOutput<Success>,
      onFailure: (error) => {
        const fields = resolveFailureFields(
          definition,
          error,
          runtimeArgs as RequestCommandArgs<Fields>,
        )

        return definition.failure.make({
          ...fields,
          request: (runtimeArgs as RequestCommandArgs<Fields>).request,
        } as never) as MessageOutput<Failure>
      },
    }),
  )

  const messages = [definition.success, definition.failure] as const
  const config = Object.freeze({ args, messages, execute: constructResult })

  return Command.define(name, config)
}

const mutation = <
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends MessageConstructor,
  Failure extends MessageConstructor,
  Error,
  Requirements,
>(
  name: Name,
  definition: BrowserMutationDefinition<Fields, Success, Failure, Error, Requirements>,
) => {
  const args = Record.set(definition.args, "request", RequestTokenSchema) as
    Fields & globalThis.Record<"request", typeof RequestTokenSchema>

  type RuntimeArgs = Schema.Schema.Type<Schema.Struct<typeof args>>

  const constructMutationResult = (runtimeArgs: RuntimeArgs) => {
    const keys = resolveReactivityKeys(
      definition.invalidates,
      runtimeArgs as RequestCommandArgs<Fields>,
    )

    const operation = definition.execute(runtimeArgs as RequestCommandArgs<Fields>)
    const mutated = Reactivity.mutation(operation, keys)

    return pipe(
      mutated,
      Effect.match({
        onSuccess: (payload) => definition.success.make({
          ...payload,
          request: (runtimeArgs as RequestCommandArgs<Fields>).request,
        } as never) as MessageOutput<Success>,
        onFailure: (error) => {
          const fields = resolveFailureFields(
            definition,
            error,
            runtimeArgs as RequestCommandArgs<Fields>,
          )

          return definition.failure.make({
            ...fields,
            request: (runtimeArgs as RequestCommandArgs<Fields>).request,
          } as never) as MessageOutput<Failure>
        },
      }),
    )
  }

  const messages = [definition.success, definition.failure] as const
  const config = Object.freeze({ args, messages, execute: constructMutationResult })

  return Command.define(name, config)
}

export const RpcBrowser = { messageFromUnknown, layer, protocol, requestOptions, command, mutation, query }
