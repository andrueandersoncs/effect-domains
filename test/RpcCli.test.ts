import { BunServices } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Array, Effect, Stream, pipe } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const runBun = Effect.fn("RpcCli.runBun")(function* (arguments_: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const rootUrl = new URL("..", import.meta.url)

  const command = ChildProcess.make(process.execPath, arguments_, {
    cwd: rootUrl.pathname,
    env: { RESERVATIONS_URL: "http://127.0.0.1:1/rpc/v1" },
    extendEnv: true,
  })

  const child = yield* spawner.spawn(command)
  const stdout = pipe(child.stdout, Stream.decodeText(), Stream.mkString)
  const stderr = pipe(child.stderr, Stream.decodeText(), Stream.mkString)
  return yield* Effect.all({ stdout, stderr, exitCode: child.exitCode }, { concurrency: "unbounded" })
})

it.effect(
  "invalid CLI payloads fail on stderr without contaminating JSON stdout",
  Effect.fn("RpcCli.testFailure")(function* () {
    const result = yield* runBun([
      "run", "examples/reservations/main.ts", "reserve",
      "--input-json", '{"sku":"book","quantity":0}',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("SchemaError")
  }, Effect.provide(BunServices.layer)),
)

const preservesPrototypeNamedFields = Effect.fn("RpcCli.testPrototypeNamedFields")(function* () {
  const source = `
      import { BunServices } from "@effect/platform-bun"
      import { Console, Effect, Layer, Schema } from "effect"
      import { Command } from "effect/unstable/cli"
      import { FetchHttpClient } from "effect/unstable/http"
      import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/unstable/rpc"
      import { RpcCli } from "effect-domains/rpc-cli"
      let observed
      const payload = Schema.Struct({
        ["__proto__"]: Schema.Struct({ effectDomainsProbe: Schema.String }),
      }).check(Schema.makeFilter(value => {
        observed = { own: Object.hasOwn(value, "__proto__"), value: value.__proto__.effectDomainsProbe }
        return false
      }))
      const group = RpcGroup.make(Rpc.make("probe", { payload, success: Schema.Void }))
      const protocol = RpcClient.layerProtocolHttp({ url: "http://127.0.0.1:1" }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(RpcSerialization.layerJson),
      )
      const cli = RpcCli.make({ name: "probe-cli", group, protocol, subcommands: [] })
      await Effect.runPromise(Effect.gen(function* () {
        yield* Effect.exit(Command.runWith(cli, { version: "test", renderErrors: false })([
          "probe", "--input-json", '{"__proto__":{"effectDomainsProbe":"sentinel"}}',
        ]))
        yield* Console.log(JSON.stringify({
          observed,
          polluted: Object.hasOwn(Object.prototype, "effectDomainsProbe"),
        }))
      }).pipe(Effect.provide(BunServices.layer)))
    `

  const result = yield* runBun(["--eval", source])

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe("")
  const output = JSON.parse(result.stdout)

  expect(output).toEqual({
    observed: { own: true, value: "sentinel" },
    polluted: false,
  })
}, Effect.provide(BunServices.layer))

it.effect(
  "canonical JSON preserves prototype-named fields without mutating prototypes",
  preservesPrototypeNamedFields,
)

it.effect(
  "omitted CLI input derives void JSON null while retaining empty struct payloads",
  Effect.fn("RpcCli.testEmptyPayloads")(function* () {
    const source = `
      import { BunServices } from "@effect/platform-bun"
      import { Effect, Layer, Schema } from "effect"
      import { Command } from "effect/unstable/cli"
      import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
      import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
      import { RpcCli } from "effect-domains/rpc-cli"
      const observed = { pingPayloadIsVoid: false, emptyPayloadIsEmpty: false }
      const ping = Rpc.make("ping")
      const empty = Rpc.make("empty", { payload: Schema.Struct({}), success: Schema.Void })
      const group = RpcGroup.make(ping, empty)
      const handlers = group.toLayer({
        ping: (payload) => Effect.sync(() => { observed.pingPayloadIsVoid = payload === undefined }),
        empty: (payload) => Effect.sync(() => { observed.emptyPayloadIsEmpty = Object.keys(payload).length === 0 }),
      })
      const routes = RpcServer.layerHttp({ group, path: "/rpc", protocol: "http" }).pipe(
        Layer.provide(handlers),
        Layer.provide(RpcSerialization.layerJson),
      )
      const web = HttpRouter.toWebHandler(routes, { disableLogger: true })
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: web.handler })
      const protocol = RpcClient.layerProtocolHttp({ url: "http://127.0.0.1:" + server.port + "/rpc" }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(RpcSerialization.layerJson),
      )
      const cli = RpcCli.make({ name: "probe-cli", group, protocol, subcommands: [] })
      try {
        await Effect.runPromise(Effect.gen(function* () {
          const run = Command.runWith(cli, { version: "test", renderErrors: false })
          yield* run(["ping"])
          yield* run(["empty"])
          yield* run(["ping", "--input-json", "null"])
          yield* run(["empty", "--input-json", "{}"])
        }).pipe(Effect.provide(BunServices.layer)))
        console.log(JSON.stringify(observed))
      } finally {
        server.stop()
        await web.dispose()
      }
    `

    const result = yield* runBun(["--eval", source])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const outputLines = result.stdout.trim().split("\n")
    const values = Array.map(outputLines, (line) => JSON.parse(line, undefined))
    expect(values).toEqual([null, null, null, null, { pingPayloadIsVoid: true, emptyPayloadIsEmpty: true }])
  }, Effect.provide(BunServices.layer)),
)

it.effect(
  "RPC commands reject missing fields and malformed JSON without JSON stdout",
  Effect.fn("RpcCli.testJsonOnly")(function* () {
    const argumentsList = [
      ["--input-json", "{"],
      ["--input-json", "{}"],
      [],
    ]

    yield* Effect.forEach(argumentsList, Effect.fn("RpcCli.testRejectedArguments")(function* (arguments_) {
      const result = yield* runBun(["run", "examples/reservations/main.ts", "reserve", ...arguments_])
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr.length).toBeGreaterThan(0)
    }))
  }, Effect.provide(BunServices.layer)),
)

it.effect(
  "help exposes JSON input and application subcommands retain inspection schemas",
  Effect.fn("RpcCli.testHelpAndInspect")(function* () {
    const help = yield* runBun(["run", "examples/reservations/main.ts", "reserve", "--help"])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain("--input-json")
    const helpOutput = expect(help.stdout)
    helpOutput.not.toContain("--sku")
    helpOutput.not.toContain("--quantity")
    const rootHelp = yield* runBun(["run", "examples/reservations/main.ts", "--help"])
    expect(rootHelp.exitCode).toBe(0)
    expect(rootHelp.stdout).toContain("serve")
    expect(rootHelp.stdout).toContain("inspect")
    const inspection = yield* runBun(["run", "examples/reservations/main.ts", "inspect", "reserve"])
    expect(inspection.exitCode).toBe(0)
    expect(inspection.stderr).toBe("")
    const metadata = JSON.parse(inspection.stdout)
    expect(metadata.operations).toHaveLength(1)
    expect(inspection.stdout).toContain('"sku"')
    expect(inspection.stdout).toContain('"quantity"')
  }, Effect.provide(BunServices.layer)),
)

it.effect(
  "RPC commands reject native flags even when canonical JSON is also supplied",
  Effect.fn("RpcCli.testRejectedFlags")(function* () {
    const argumentsList = [
      ["--sku", "book", "--quantity", "1"],
      ["--input-json", '{"sku":"book","quantity":1}', "--sku", "book"],
    ]

    yield* Effect.forEach(argumentsList, Effect.fn("RpcCli.testNativeFlag")(function* (arguments_) {
      const result = yield* runBun(["run", "examples/reservations/main.ts", "reserve", ...arguments_])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("sku")
      expect(result.stdout).toContain("USAGE")
    }))
  }, Effect.provide(BunServices.layer)),
)

it.effect(
  "canonical JSON keeps nested values, codecs, and formerly colliding field names",
  Effect.fn("RpcCli.testCanonicalCodecs")(function* () {
    const source = `
      import { BunServices } from "@effect/platform-bun"
      import { Context, Effect, Layer, Schema, SchemaGetter } from "effect"
      import { Command } from "effect/unstable/cli"
      import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
      import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
      import { RpcCli } from "effect-domains/rpc-cli"
      class Endpoint extends Context.Service()("test/Endpoint") {}
      class Prefix extends Context.Service()("test/Prefix") {}
      const text = Schema.String.pipe(Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transformOrFail(Effect.fn(function* (value) {
          const prefix = yield* Prefix
          return value.slice(prefix.length)
        })),
        encode: SchemaGetter.transformOrFail(Effect.fn(function* (value) {
          const prefix = yield* Prefix
          return prefix + value
        })),
      }))
      const payload = Schema.Struct({
        inputJson: text,
        help: Schema.String,
        fooBar: Schema.String,
        foo_bar: Schema.String,
        amount: Schema.NumberFromString,
        when: Schema.DateFromString,
        nested: Schema.Struct({
          values: Schema.Array(Schema.NullOr(Schema.String)),
          choice: Schema.Union([Schema.String, Schema.Number]),
          dictionary: Schema.Record(Schema.String, Schema.Boolean),
        }),
      })
      const failure = Schema.Struct({ _tag: Schema.Literal("Rejected"), amount: Schema.NumberFromString })
      const group = RpcGroup.make(
        Rpc.make("echo", { payload, success: payload }),
        Rpc.make("reject", { payload: Schema.NumberFromString, error: failure }),
        Rpc.make("scalar", { payload: Schema.NumberFromString, success: Schema.NumberFromString }),
      )
      let decoded = false
      const handlers = group.toLayer({
        echo: (value) => Effect.sync(() => {
          decoded = value.amount === 42 && value.when instanceof Date && value.inputJson === "canonical"
          return value
        }),
        reject: (amount) => Effect.fail({ _tag: "Rejected", amount }),
        scalar: Effect.succeed,
      })
      const routes = RpcServer.layerHttp({ group, path: "/rpc", protocol: "http" }).pipe(
        Layer.provide(handlers),
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(Layer.succeed(Prefix, "wire:")),
      )
      const web = HttpRouter.toWebHandler(routes, { disableLogger: true })
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: web.handler })
      const protocol = Layer.unwrap(Effect.gen(function* () {
        const url = yield* Endpoint
        return RpcClient.layerProtocolHttp({ url }).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(RpcSerialization.layerJson),
        )
      }))
      const cli = RpcCli.make({ name: "probe-cli", group, protocol, subcommands: [] })
      const input = {
        inputJson: "wire:canonical", help: "ordinary field", fooBar: "camel", foo_bar: "snake",
        amount: "42", when: "2026-01-02T03:04:05.000Z",
        nested: { values: ["one", null], choice: 7, dictionary: { enabled: true } },
      }
      try {
        await Effect.runPromise(Effect.gen(function* () {
          const run = Command.runWith(cli, { version: "test", renderErrors: false })
          yield* run(["echo", "--input-json", JSON.stringify(input)])
          yield* run(["scalar", "--input-json", '\"7\"'])
          const error = yield* run(["reject", "--input-json", '\"9\"']).pipe(Effect.flip)
          console.log(JSON.stringify({ decoded, error: JSON.parse(error.userMessage) }))
        }).pipe(
          Effect.provideService(Endpoint, "http://127.0.0.1:" + server.port + "/rpc"),
          Effect.provideService(Prefix, "wire:"),
          Effect.provide(BunServices.layer),
        ))
      } finally {
        server.stop()
        await web.dispose()
      }
    `

    const result = yield* runBun(["--eval", source])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const lines = result.stdout.trim().split("\n")
    const values = Array.map(lines, (line) => JSON.parse(line, undefined))

    expect(values).toEqual([
      {
        inputJson: "wire:canonical", help: "ordinary field", fooBar: "camel", foo_bar: "snake",
        amount: "42", when: "2026-01-02T03:04:05.000Z",
        nested: { values: ["one", null], choice: 7, dictionary: { enabled: true } },
      },
      "7",
      { decoded: true, error: { _tag: "Rejected", amount: "9" } },
    ])
  }, Effect.provide(BunServices.layer)),
)
