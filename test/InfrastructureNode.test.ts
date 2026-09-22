import { realpathSync } from "node:fs"
import { BunServices } from "@effect/platform-bun"
import { applicationUiExtraFiles } from "@effect-domains/alchemy"
import { expect, it } from "@effect/vitest"
import { Array, Effect, Stream, Struct, pipe } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const resolveNodeBinary = () => pipe(
  process.env.NODE_BINARY ?? "/usr/bin/node",
  realpathSync,
  String,
)

const source = `
import { readFile } from "node:fs/promises"
import { applicationUiExtraFiles } from "@effect-domains/alchemy"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as ApplicationRuntime from "effect-domains/application-runtime"
import { SqliteNodeRuntime } from "effect-domains/sqlite-node"
import { ApplicationInfrastructure } from "effect-domains/application-infrastructure"
import { ReadingListInfrastructureIR } from "./examples/reading-list/infrastructure.ts"

const javascriptFile = applicationUiExtraFiles.find(({ dest }) => dest === "application-ui/client.js")
const stylesheetFile = applicationUiExtraFiles.find(({ dest }) => dest === "application-ui/style.css")
if (javascriptFile === undefined || stylesheetFile === undefined) throw new Error("Application UI deployment artifacts are incomplete")

const javascript = await readFile(javascriptFile.source, "utf8")
const stylesheet = await readFile(stylesheetFile.source, "utf8")
const request = (url) => HttpServerRequest.fromWeb(new Request(url))

const program = Effect.scoped(Effect.gen(function* () {
  const plan = yield* ApplicationInfrastructure.plan("Node smoke test", ReadingListInfrastructureIR)
  const http = ApplicationInfrastructure.httpOptions(plan.runtime.resource)
  const handler = yield* ApplicationRuntime.httpEffect(
    plan.application,
    SqliteNodeRuntime.sqlClient(":memory:", { migrations: plan.database.resource.migrations }),
    { rpc: http.rpc, mcp: http.mcp, ui: http.ui, uiAssets: { javascript, stylesheet }, telemetry: false },
  )

  const rootResponse = yield* Effect.provideService(
    handler,
    HttpServerRequest.HttpServerRequest,
    request("http://localhost/"),
  )

  const metadataResponse = yield* Effect.provideService(
    handler,
    HttpServerRequest.HttpServerRequest,
    request("http://localhost/api"),
  )

  const root = HttpServerResponse.toWeb(rootResponse)
  const metadataWeb = HttpServerResponse.toWeb(metadataResponse)
  const metadata = yield* Effect.promise(() => metadataWeb.json())
  return { rootStatus: root.status, metadataStatus: metadataWeb.status, metadata }
}))

console.log(JSON.stringify(await Effect.runPromise(program)))
`

const runNode = Effect.fn("InfrastructureNode.run")(function* () {
  const nodeBinary = yield* Effect.sync(resolveNodeBinary)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = new URL("..", import.meta.url)

  const command = ChildProcess.make(nodeBinary, [
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    source,
  ], {
    cwd: root.pathname,
    extendEnv: true,
    env: { BUN_BE_BUN: "0" },
  })

  const child = yield* spawner.spawn(command)
  const stdout = pipe(child.stdout, Stream.decodeText(), Stream.mkString)
  const stderr = pipe(child.stderr, Stream.decodeText(), Stream.mkString)

  return yield* Effect.all({ stdout, stderr, exitCode: child.exitCode }, { concurrency: "unbounded" })
})

it.effect("provider UI artifacts serve through the portable Node runtime", Effect.fn("InfrastructureNode.smoke")(function* () {
  const destinations = Array.map(applicationUiExtraFiles, Struct.get("dest"))

  expect(destinations).toEqual(["application-ui/client.js", "application-ui/style.css"])

  const result = yield* runNode()

  expect(result.exitCode, result.stderr).toBe(0)

  const output = JSON.parse(result.stdout)

  expect(output).toMatchObject({
    rootStatus: 200,
    metadataStatus: 200,
    metadata: {
      application: "reading-list",
      presentation: { title: "Reading list" },
    },
  })
}, Effect.provide(BunServices.layer)))
