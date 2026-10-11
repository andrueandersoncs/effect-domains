import { Config, Effect, Equal, Function, Option, Predicate, Redacted, Schema, String as Text, flow, pipe } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { MakeDirectoryOptions, RmOptions } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcceptanceError, PayloadSchema, type Payload } from "./model.ts"

/** A secret credential stays redacted because issued tokens and keys must never reach retained evidence. */
export type Secret = Redacted.Redacted<string>

const loopback = "127.0.0.1"

const repositoryRoot = new URL("../../../", import.meta.url).pathname

const removal: RmOptions = { recursive: true, force: true }

const creation: MakeDirectoryOptions = { recursive: true }

const VariablesSchema = Schema.Record(Schema.String, Schema.String)

const ChildEnvironmentSchema = Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String))

/** The served application is described by data because the fixture owns everything application-specific. */
export class ServerSpec extends Schema.Class<ServerSpec>("ServerSpec")({
  application: Schema.NonEmptyString,
  entry: Schema.NonEmptyString,
  prefix: Schema.NonEmptyString,
  artifacts: Schema.String,
}) {}

class ServedApplication extends Schema.Class<ServedApplication>("ServedApplication")({
  url: Schema.String,
  directory: Schema.String,
}) {}

const OptionalValueSchema = Schema.OptionFromOptionalKey(Schema.Unknown)

const ReplySchema = Schema.Struct({ result: OptionalValueSchema, error: OptionalValueSchema })

interface Reply extends Schema.Schema.Type<typeof ReplySchema> {}

class CallResponse extends Schema.Class<CallResponse>("CallResponse")({
  status: Schema.Int,
  result: OptionalValueSchema,
  error: OptionalValueSchema,
}) {}

const MetadataSchema = Schema.Struct({ application: Schema.String })

interface Metadata extends Schema.Schema.Type<typeof MetadataSchema> {}

const CallSchema = Schema.Struct({ operation: Schema.String, input: PayloadSchema })

interface Call extends Schema.Schema.Type<typeof CallSchema> {}

const VariableSchema = Schema.UndefinedOr(Schema.String)

const ProcessEnvironmentSchema = Schema.Struct({
  PATH: VariableSchema,
  HOME: VariableSchema,
  TMPDIR: VariableSchema,
})

interface ProcessEnvironment extends Schema.Schema.Type<typeof ProcessEnvironmentSchema> {}

const BaseEnvironmentSchema = Schema.Struct({
  PATH: VariableSchema,
  HOME: VariableSchema,
  TMPDIR: VariableSchema,
  PORT: Schema.String,
})

interface BaseEnvironment extends Schema.Schema.Type<typeof BaseEnvironmentSchema> {}

/** One owned process role because the server and its workers run different commands and keep separate logs. */
class ProcessRole extends Schema.Class<ProcessRole>("ProcessRole")({
  command: Schema.NonEmptyString,
  log: Schema.NonEmptyString,
}) {}

const serverRole = ProcessRole.make({ command: "serve", log: "server" })

const workerRole = ProcessRole.make({ command: "worker", log: "worker" })

const serverError = (message: string) => AcceptanceError.make({ boundary: "fixture", message })

const describeFailure = flow(String, serverError)

// Secret-bearing boundaries use fixed messages because their causes can retain the environment, request body, or issued token.
const spawnFailed = pipe("Application process could not be spawned", serverError, Function.constant)

const callFailed = pipe("Fixture HTTP call failed before a decodable reply", serverError, Function.constant)

const optionalVariable = flow(Config.string, Config.option, Config.map(Option.getOrUndefined))

const pathVariable = optionalVariable("PATH")

const homeVariable = optionalVariable("HOME")

const temporaryVariable = optionalVariable("TMPDIR")

const EnvironmentConfig = Config.all([pathVariable, homeVariable, temporaryVariable])

const reservedResponse = () => new globalThis.Response("reserved")

const reservation: Bun.Serve.Options<undefined> = { hostname: loopback, port: 0, fetch: reservedResponse }

const reservePort = () => {
  const reserved = Bun.serve(reservation)
  const { port } = reserved

  reserved.stop(true)

  return port
}

const makeDirectory = Effect.fn("Acceptance.server.directory")(function* (prefix: string) {
  const temporaryRoot = yield* Effect.sync(tmpdir)
  const temporaryPrefix = join(temporaryRoot, prefix)

  return yield* Effect.tryPromise({
    try: () => mkdtemp(temporaryPrefix),
    catch: describeFailure,
  })
})

const removeDirectory = (directory: string) => Effect.promise(() => rm(directory, removal))

/** A private temporary directory under the system temporary root that is removed when its scope closes, because no run or test may leave one behind. */
export const scopedTemporaryDirectory = Effect.fn("Acceptance.server.scopedTemporaryDirectory")(function* (prefix: string) {
  const created = makeDirectory(prefix)

  return yield* Effect.acquireRelease(created, removeDirectory)
})

const stopChild = Effect.fn("Acceptance.server.stop")(function* (child: Bun.Subprocess) {
  yield* Effect.sync(() => child.kill())
  yield* Effect.promise(() => child.exited)
})

const processEnvironment = Effect.fn("Acceptance.server.environment")(function* () {
  const [PATH, HOME, TMPDIR] = yield* pipe(EnvironmentConfig, Effect.mapError(describeFailure))
  const inherited: ProcessEnvironment = ProcessEnvironmentSchema.make({ PATH, HOME, TMPDIR })

  return inherited
})

const logPath = (spec: ServerSpec, role: ProcessRole, stream: string) => join(spec.artifacts, `${role.log}.${stream}.log`)

// The base variables override the derived ones because a fixture must not redirect PATH, HOME, TMPDIR, or the listener port.
const spawnProcess = Effect.fn("Acceptance.server.spawn")(function* (spec: ServerSpec, role: ProcessRole, base: ProcessEnvironment, variables: Readonly<Record<string, string>>) {
  yield* Effect.tryPromise({
    try: () => mkdir(spec.artifacts, creation),
    catch: describeFailure,
  })

  const stdoutPath = logPath(spec, role, "stdout")
  const stderrPath = logPath(spec, role, "stderr")
  const stdout = Bun.file(stdoutPath)
  const stderr = Bun.file(stderrPath)
  const env = ChildEnvironmentSchema.make({ ...variables, ...base })
  const command = [process.execPath, "run", spec.entry, role.command]

  return yield* Effect.try({
    try: () => Bun.spawn(command, { cwd: repositoryRoot, env, stdout, stderr }),
    catch: spawnFailed,
  })
})

const spawnServer = Effect.fn("Acceptance.server.spawnServer")(function* (spec: ServerSpec, port: number, variables: Readonly<Record<string, string>>) {
  const inherited = yield* processEnvironment()
  const PORT = String(port)
  const base: BaseEnvironment = BaseEnvironmentSchema.make({ ...inherited, PORT })

  return yield* spawnProcess(spec, serverRole, base, variables)
})

const metadata = Effect.fn("Acceptance.server.metadata")(function* (url: string, application: string) {
  const client = yield* HttpClient.HttpClient

  const decoded: Metadata = yield* pipe(
    client.get(`${url}/api`),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(MetadataSchema)),
  )

  if (!Equal.equals(decoded.application, application)) {
    return yield* serverError(`Served application ${decoded.application} is not ${application}`)
  }

  return decoded
})

const exitedMessage = (exitCode: number | null) => `Application exited with ${String(exitCode)}; inspect server.stderr.log`

const awaitReady = (child: Bun.Subprocess, url: string, application: string): Effect.Effect<Metadata, AcceptanceError, HttpClient.HttpClient> => {
  const exited = Predicate.isNotNull(child.exitCode)
  const exitError = pipe(child.exitCode, exitedMessage, serverError)
  const retry = Effect.suspend(() => awaitReady(child, url, application))
  const later = pipe(Effect.sleep("100 millis"), Effect.andThen(retry))
  const retryLater = Effect.catch(Function.constant(later))

  return exited
    ? Effect.fail(exitError)
    : pipe(metadata(url, application), retryLater)
}

const notReady = serverError("Application did not become ready within 20 seconds")

const notReadyFailure = Effect.fail(notReady)

const failNotReady = Function.constant(notReadyFailure)

const choosePort = pipe(
  Effect.try({ try: reservePort, catch: describeFailure }),
  Effect.flatMap(Effect.fromNullishOr),
  Effect.mapError(describeFailure),
)

const workerExitedMessage = (exitCode: number | null) => `Worker exited with ${String(exitCode)}; inspect worker.stderr.log`

const logText = (path: string) => Effect.tryPromise({ try: () => Bun.file(path).text(), catch: describeFailure })

const emptyLog = Function.constant("")

const readLog = flow(logText, Effect.orElseSucceed(emptyLog))

const readinessLine = (spec: ServerSpec) => `Worker ready: ${spec.application}`

// Both streams are searched because the application's logger may write its lifecycle line to either.
const workerLogged = Effect.fn("Acceptance.server.workerLogged")(function* (spec: ServerSpec) {
  const line = readinessLine(spec)
  const stdoutPath = logPath(spec, workerRole, "stdout")
  const stderrPath = logPath(spec, workerRole, "stderr")
  const stdout = yield* readLog(stdoutPath)
  const stderr = yield* readLog(stderrPath)
  const loggedOut = Text.includes(line)(stdout)

  return loggedOut || Text.includes(line)(stderr)
})

/** The readiness line the worker logged, once it appears, because the worker listens for no request a fixture could probe. */
const workerReadiness = (child: Bun.Subprocess, spec: ServerSpec): Effect.Effect<string, AcceptanceError> => {
  const exited = Predicate.isNotNull(child.exitCode)
  const exitError = pipe(child.exitCode, workerExitedMessage, serverError)
  const retry = Effect.suspend(() => workerReadiness(child, spec))
  const later = pipe(Effect.sleep("100 millis"), Effect.andThen(retry))
  const logged = pipe(spec, readinessLine, Effect.succeed)
  const settle = (ready: boolean) => ready ? logged : later

  return exited
    ? Effect.fail(exitError)
    : pipe(workerLogged(spec), Effect.flatMap(settle))
}

const workerNotReady = serverError("Worker did not log its readiness within 20 seconds; inspect worker.stderr.log")

const workerNotReadyFailure = Effect.fail(workerNotReady)

const failWorkerNotReady = Function.constant(workerNotReadyFailure)

/**
 * Serves the application in an owned process because acceptance must exercise the real server with isolated state.
 * The process sees only PATH, HOME, TMPDIR, PORT, and the variables derived from its private directory.
 */
export const serve = Effect.fn("Acceptance.server.serve")(function* (spec: ServerSpec, environment: (directory: string) => Readonly<Record<string, string>>) {
  const directory = yield* scopedTemporaryDirectory(spec.prefix)
  const port = yield* choosePort
  const url = `http://${loopback}:${String(port)}`
  const variables = yield* pipe(environment(directory), Schema.decodeUnknownEffect(VariablesSchema), Effect.mapError(spawnFailed))
  const spawned = spawnServer(spec, port, variables)
  const child = yield* Effect.acquireRelease(spawned, stopChild)

  yield* pipe(
    awaitReady(child, url, spec.application),
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: failNotReady }),
  )

  return ServedApplication.make({ url, directory })
}, Effect.provide(FetchHttpClient.layer))

/**
 * Starts the application's `worker` command in an owned process because durable work must complete in the real topology, not in-process.
 * The worker sees only PATH, HOME, TMPDIR, and the variables derived from the served application's private directory and its own free
 * loopback port; it is stopped when the scope closes, before the served application it shares stores with.
 */
export const startWorker = Effect.fn("Acceptance.server.startWorker")(function* (spec: ServerSpec, directory: string, environment: (directory: string, port: number) => Readonly<Record<string, string>>) {
  const port = yield* choosePort
  const variables = yield* pipe(environment(directory, port), Schema.decodeUnknownEffect(VariablesSchema), Effect.mapError(spawnFailed))
  const inherited = yield* processEnvironment()
  const spawned = spawnProcess(spec, workerRole, inherited, variables)
  const child = yield* Effect.acquireRelease(spawned, stopChild)

  yield* pipe(
    workerReadiness(child, spec),
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: failWorkerNotReady }),
  )
})

type Authorization = (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest

const unauthorized: () => Authorization = Function.constant(Function.identity)

const authorize = (token: Option.Option<Secret>) => Option.match<Secret, Authorization, Authorization>(token, { onNone: unauthorized, onSome: HttpClientRequest.bearerToken })

const decodeReply = HttpClientResponse.schemaBodyJson(ReplySchema)

// Every HTTP status is retained because denials and rejections are observations, not transport failures.
export const call = Effect.fn("Acceptance.server.call")(function* (url: string, operation: string, input: Payload, token: Option.Option<Secret>) {
  const client = yield* HttpClient.HttpClient
  const body: Call = CallSchema.make({ operation, input })
  const authorization = authorize(token)

  const request = yield* pipe(
    HttpClientRequest.post(`${url}/api/call`),
    HttpClientRequest.setHeader("Origin", url),
    authorization,
    HttpClientRequest.bodyJson(body),
  )

  const response = yield* client.execute(request)

  const reply: Reply = yield* HttpClientResponse.matchStatus(response, {
    "2xx": decodeReply,
    orElse: decodeReply,
  })

  return CallResponse.make({ status: response.status, result: reply.result, error: reply.error })
}, Effect.mapError(callFailed), Effect.provide(FetchHttpClient.layer))
