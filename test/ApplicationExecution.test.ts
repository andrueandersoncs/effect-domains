import { BunServices } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Stream, pipe } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const source = `
  import { Context, Effect, Layer } from "effect"
  import { SqlClient } from "effect/unstable/sql"
  import { Application } from "effect-domains/application"
  import * as ApplicationBun from "effect-domains/application-bun"
  import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
  class PrivateSql extends Context.Service()("test/PrivateSql") {}
  process.argv = [process.execPath, "execution-isolation", "worker"]
  const app = Effect.runSync(Application.compile(Application.define({ name: "execution-isolation", parts: [] })))
  const privateDatabase = SqliteBunRuntime.privateClient({ application: "execution-isolation", purpose: "execution" })
  const services = Layer.effect(PrivateSql, SqlClient.SqlClient).pipe(Layer.provide(privateDatabase))
  const initialize = Effect.gen(function* () {
    const application = yield* SqlClient.SqlClient
    const execution = yield* PrivateSql
    yield* application\`CREATE TABLE application_marker(value TEXT)\`
    yield* execution\`CREATE TABLE execution_marker(value TEXT)\`
    const applicationTables = yield* application\`SELECT name FROM sqlite_master WHERE name LIKE '%_marker'\`
    const executionTables = yield* execution\`SELECT name FROM sqlite_master WHERE name LIKE '%_marker'\`
    console.log(JSON.stringify({ applicationTables, executionTables }))
  })
  const program = ApplicationBun.runApplication(app, {
    database: { filename: process.env.APPLICATION_DB, migrations: [] },
    services,
    initialize,
    background: Layer.empty,
  })
  const result = await Effect.runPromise(program.pipe(Effect.timeout("500 millis"), Effect.result))
  console.log(JSON.stringify(result))
`

const runProbe = Effect.fn("ApplicationExecution.runProbe")(function* (database: string, execution: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = new URL("..", import.meta.url)

  const command = ChildProcess.make(process.execPath, ["--eval", source], {
    cwd: root.pathname,
    env: { APPLICATION_DB: database, EXECUTION_ISOLATION_EXECUTION_DB: execution },
    extendEnv: true,
  })

  const child = yield* spawner.spawn(command)
  const stdout = pipe(child.stdout, Stream.decodeText(), Stream.mkString)
  const stderr = pipe(child.stderr, Stream.decodeText(), Stream.mkString)
  const result = yield* Effect.all({ stdout, stderr, exitCode: child.exitCode }, { concurrency: "unbounded" })

  expect(result.exitCode, result.stderr).toBe(0)

  return result.stdout
})

const isolatedTables = JSON.stringify({
  applicationTables: [{ name: "application_marker" }],
  executionTables: [{ name: "execution_marker" }],
})

it.effect("private execution clients preserve application SQL isolation", Effect.fn("ApplicationExecution.nativeLayers")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped()
  const application = path.join(directory, "application.sqlite")
  const execution = path.join(directory, "execution.sqlite")
  const output = yield* runProbe(application, execution)

  expect(output).toContain(isolatedTables)
}, Effect.scoped, Effect.provide(BunServices.layer)))

it.effect("private execution clients reject aliased application databases", Effect.fn(
  "ApplicationExecution.rejectAliases",
)(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped()
  const database = path.join(directory, "application.sqlite")
  const symbolic = path.join(directory, "symbolic.sqlite")
  const hardlink = path.join(directory, "hardlink.sqlite")

  yield* fs.writeFileString(database, "")
  yield* fs.symlink(database, symbolic)
  yield* fs.link(database, hardlink)

  yield* Effect.forEach([symbolic, hardlink], Effect.fn("ApplicationExecution.checkAlias")(function* (execution) {
    const output = yield* runProbe(database, execution)

    expect(output).toContain('"_tag":"PrivateDatabaseConflict"')

    const assertion = expect(output)

    assertion.not.toContain('"applicationTables"')
  }))
}, Effect.scoped, Effect.provide(BunServices.layer)))

it.effect("distinct in-memory native connections remain isolated", Effect.fn("ApplicationExecution.memory")(function* () {
  const output = yield* runProbe(":memory:", ":memory:")

  expect(output).toContain(isolatedTables)
}, Effect.scoped, Effect.provide(BunServices.layer)))
