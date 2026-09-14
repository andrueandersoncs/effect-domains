import { Effect, Layer, Option, Schema, pipe } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { Runtime } from "foldkit"

type BrowserApplicationConfig<Model, Message, Resources> =
  Omit<
    Runtime.ApplicationConfig<Model, Message, Resources | Reactivity.Reactivity>,
    "container" | "resources"
  > & Readonly<{
    resources: Layer.Layer<Resources>
  }>

class BrowserContainerError extends Schema.TaggedError<BrowserContainerError>()("BrowserContainerError", {
  id: Schema.String,
}) {}

const findContainer = () => pipe(
  document.getElementById("root"),
  Option.fromNullishOr,
  Option.getOrThrowWith(() => BrowserContainerError.make({ id: "root" })),
)

export const BrowserRuntime = {
  run: Effect.fn("BrowserRuntime.run")(function* <
    Model,
    Message extends { readonly _tag: string },
    Resources = never,
  >(
    options: BrowserApplicationConfig<Model, Message, Resources>,
  ) {
    const container = yield* Effect.sync(findContainer)

    const resources = Layer.mergeAll(
      options.resources,
      Reactivity.layer,
    ) as Layer.Layer<Resources | Reactivity.Reactivity>

    const configuration: Runtime.ApplicationConfig<Model, Message, Resources | Reactivity.Reactivity> = {
      ...options,
      resources,
      container,
    }

    const application = Runtime.makeApplication(configuration)

    yield* Effect.sync(() => Runtime.run(application))

    return application
  }),
}
