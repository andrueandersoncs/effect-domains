import { BunServices } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Stream, pipe } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const source = `
  import { Effect, Layer } from "effect"
  import { SingleRunner } from "effect/unstable/cluster"
  import { Application } from "effect-domains/application"
  import { ApplicationBun } from "effect-domains/application-bun"
  process.argv = [process.execPath, "execution-isolation", "worker"]
  const app = Application.make({ name: "execution-isolation" })
  const program = ApplicationBun.run(app, {
    database: { filename: process.env.APPLICATION_DB, migrations: [] },
    execution: { database: process.env.EXECUTION_DB, layer: SingleRunner.layer() },
    background: Layer.empty,
  })
  const result = await Effect.runPromise(program.pipe(Effect.timeout("2 seconds"), Effect.result))
  console.log(JSON.stringify(result))
`

const runAliasProbe = Effect.fn("ApplicationExecution.runAliasProbe")(function* (database: string, execution: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = new URL("..", import.meta.url)

  const command = ChildProcess.make(process.execPath, ["--eval", source], {
    cwd: root.pathname,
    env: { APPLICATION_DB: database, EXECUTION_DB: execution },
    extendEnv: true,
  })

  const child = yield* spawner.spawn(command)
  const stdout = pipe(child.stdout, Stream.decodeText(), Stream.mkString)
  const stderr = pipe(child.stderr, Stream.decodeText(), Stream.mkString)
  const result = yield* Effect.all({ stdout, stderr, exitCode: child.exitCode }, { concurrency: "unbounded" })
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout)
})

it.effect("rejects symlink URLs and hardlink database aliases before either database is opened", Effect.fn(
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
  const symbolicUrl = yield* path.toFileUrl(symbolic)

  yield* Effect.forEach([symbolicUrl.href, hardlink], Effect.fn("ApplicationExecution.checkAlias")(function* (execution) {
    const result = yield* runAliasProbe(database, execution)

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ApplicationBunExecutionDatabaseConflictError" },
    })

    const contents = yield* fs.readFileString(database)
    expect(contents).toBe("")
  }))
}, Effect.scoped, Effect.provide(BunServices.layer)))

it.effect("rejects dangling database symlinks before creating their target", Effect.fn(
  "ApplicationExecution.rejectDanglingAlias",
)(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped()
  const database = path.join(directory, "new.sqlite")
  const symbolic = path.join(directory, "symbolic.sqlite")
  yield* fs.symlink(database, symbolic)
  const result = yield* runAliasProbe(database, symbolic)

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ApplicationBunExecutionDatabaseError" },
  })

  const exists = yield* fs.exists(database)
  expect(exists).toBe(false)
}, Effect.scoped, Effect.provide(BunServices.layer)))
