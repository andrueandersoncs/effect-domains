import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { Config, Effect, Layer, Schema, pipe } from "effect"
import { Command } from "effect/unstable/cli"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import type { MigrationError, SchemaStore } from "./migrations.ts"
import { RpcCli } from "./rpc-cli.ts"

const serveApplication = Effect.fn("ApplicationBun.serve")(function* <Services>(options: Readonly<{
  application: Readonly<{
    name: string
    group: RpcGroup.RpcGroup<any>
    prepare: Effect.Effect<void, MigrationError, SchemaStore>
  }>
  handlers: Layer.Layer<any, any, any>
  runtime: Layer.Layer<any, any, any>
  services: Layer.Layer<Services, any, any>
  initialize: Effect.Effect<unknown, any, any>
}>) {
  const port = yield* pipe(Config.port("PORT"), Config.withDefault(3000))
  const runtime = Layer.provideMerge(options.services, options.runtime)

  const routes = pipe(
    RpcServer.layerHttp({
      group: options.application.group,
      path: "/rpc/v1",
      protocol: "http",
    }),
    Layer.provide(options.handlers),
    Layer.provide(RpcSerialization.layerJson),
  )

  const bunServer = BunHttpServer.layer({ hostname: "127.0.0.1", port })

  const server = pipe(
    HttpRouter.serve(routes),
    Layer.provide(bunServer),
  )

  yield* pipe(
    Effect.gen(function* () {
      yield* options.application.prepare
      yield* options.initialize
      return yield* Layer.launch(server)
    }),
    Effect.provide(runtime),
  )
})

export const ApplicationBun = {
  serve: serveApplication,

  cli: Effect.fn("ApplicationBun.cli")(
    function* <E, R>(options: Readonly<{
      application: Readonly<{ name: string; group: RpcGroup.RpcGroup<any> }>
      schema: Command.Command<string, {}, {}, E, R>
    }>) {
      const urlEnvironmentVariable = `${options.application.name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_URL`
      const defaultUrl = new URL("http://127.0.0.1:3000/rpc/v1")

      const url = yield* pipe(
        Config.schema(
          Schema.URLFromString,
          urlEnvironmentVariable,
        ),
        Config.withDefault(defaultUrl),
      )

      const protocol = pipe(
        RpcClient.layerProtocolHttp({ url: url.href }),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(RpcSerialization.layerJson),
      )

      const command = RpcCli.make({
        name: options.application.name,
        group: options.application.group,
        subcommands: [options.schema],
      })

      yield* pipe(
        Command.run(command, { version: "0.1.0" }),
        Effect.provide(protocol),
      )
    },
    Effect.provide(BunServices.layer),
  ),
}
