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
        "examples/reservations/main.ts",
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
