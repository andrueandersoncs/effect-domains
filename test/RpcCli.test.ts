import { BunServices } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Effect, Stream, pipe } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

it.effect(
  "invalid CLI payloads fail on stderr without contaminating JSON stdout",
  Effect.fn("RpcCli.testFailure")(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const rootUrl = new URL("..", import.meta.url)

    const command = ChildProcess.make(
      process.execPath,
      [
        "run",
        "apps/reservations/main.ts",
        "reserve",
        "--sku",
        "book",
        "--quantity",
        "0",
      ],
      {
        cwd: rootUrl.pathname,
        env: { RESERVATIONS_URL: "http://127.0.0.1:1/rpc/v1" },
        extendEnv: true,
      },
    )

    const child = yield* spawner.spawn(command)
    const stdout = pipe(child.stdout, Stream.decodeText(), Stream.mkString)
    const stderr = pipe(child.stderr, Stream.decodeText(), Stream.mkString)

    const result = yield* Effect.all(
      {
        stdout,
        stderr,
        exitCode: child.exitCode,
      },
      { concurrency: "unbounded" },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("SchemaError")
  }, Effect.provide(BunServices.layer)),
)

const preservesPrototypeNamedFields = Effect.fn("RpcCli.testPrototypeNamedFields")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

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
          "probe", "----proto---effect-domains-probe", "sentinel",
        ]))
        yield* Console.log(JSON.stringify({
          observed,
          polluted: Object.hasOwn(Object.prototype, "effectDomainsProbe"),
        }))
      }).pipe(Effect.provide(BunServices.layer)))
    `

  const rootUrl = new URL("..", import.meta.url)

  const command = ChildProcess.make(process.execPath, ["--eval", source], {
    cwd: rootUrl.pathname,
  })

  const child = yield* spawner.spawn(command)
  const stdout = pipe(child.stdout, Stream.decodeText(), Stream.mkString)
  const stderr = pipe(child.stderr, Stream.decodeText(), Stream.mkString)

  const result = yield* Effect.all(
    { stdout, stderr, exitCode: child.exitCode },
    { concurrency: "unbounded" },
  )

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe("")
  const output = JSON.parse(result.stdout)

  expect(output).toEqual({
    observed: { own: true, value: "sentinel" },
    polluted: false,
  })
}, Effect.provide(BunServices.layer))

it.effect(
  "native nested flags preserve prototype-named fields without mutating prototypes",
  preservesPrototypeNamedFields,
)
