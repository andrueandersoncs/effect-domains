import { BunRuntime } from "@effect/platform-bun"
import { Context, Effect, Layer, Schema, pipe } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/unstable/rpc"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { NotesApplication } from "../examples/service-codec/application.ts"
import { StoragePrefix, StoredTextSchema } from "../examples/service-codec/storage.ts"
import { Application } from "effect-domains/application"
import { ApplicationBun } from "effect-domains/application-bun"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false

const emptyApplication = Application.make({ name: "empty" })

const nestedNotes = Application.make({
  name: "nested-notes",
  parts: [emptyApplication, NotesApplication],
})

const missing = ApplicationBun.run(nestedNotes, {
  database: { migrations: [] },
})

const storedPrefix = Layer.succeed(StoragePrefix, { value: "stored:" })

const storedTextRpc = Rpc.make("stored-text", {
  payload: StoredTextSchema,
  success: StoredTextSchema,
  error: Schema.Never,
})

const storedTextGroup = RpcGroup.make(storedTextRpc)

const storedTextApplication = Application.make({ name: "stored-text", parts: [{ group: storedTextGroup, handlers: Layer.empty }] })

const storedTextCli = ApplicationBun.run(storedTextApplication, {
  database: { migrations: [] },
  services: storedPrefix,
})

const complete = ApplicationBun.run(nestedNotes, {
  database: { migrations: [] },
  services: storedPrefix,
})

class ExecutionDependency extends Context.Service<ExecutionDependency, {}>()("test/ApplicationBunExecution/ExecutionDependency") {}
class ExecutionOutput extends Context.Service<ExecutionOutput, {}>()("test/ApplicationBunExecution/ExecutionOutput") {}
class BackgroundDependency extends Context.Service<BackgroundDependency, {}>()("test/ApplicationBunExecution/BackgroundDependency") {}
class RoutesDependency extends Context.Service<RoutesDependency, {}>()("test/ApplicationBunExecution/RoutesDependency") {}

const makeExecution = Effect.gen(function* () {
  yield* ExecutionDependency
  return {}
})

const execution = Layer.effect(ExecutionOutput, makeExecution)

const executionOutput = Effect.gen(function* () {
  yield* ExecutionOutput
})

const background = pipe(BackgroundDependency, Effect.asVoid, Layer.effectDiscard)

const route = Effect.gen(function* () {
  yield* RoutesDependency
  return HttpServerResponse.empty()
})

const routes = HttpRouter.add("GET", "/probe", route)
const services = pipe(Layer.effectDiscard(executionOutput), Layer.provideMerge(execution))

const nativeRuntime = ApplicationBun.run(emptyApplication, {
  database: { migrations: [] },
  services,
  initialize: executionOutput,
  background,
  routes,
})

class MiddlewareRequirement extends RpcMiddleware.Service<MiddlewareRequirement>()("test/ApplicationBunExecution/MiddlewareRequirement", {
  error: Schema.Never,
}) {}

const middlewareRpc = Rpc.make("middleware-requirement", {
  payload: Schema.Void,
  success: Schema.Void,
  error: Schema.Never,
})

const middlewareGroup = RpcGroup.make(middlewareRpc).middleware(MiddlewareRequirement)

const middlewareApplication = Application.make({ name: "middleware-requirement", parts: [{
  group: middlewareGroup,
  handlers: Layer.empty,
}] })

const middlewareRuntime = ApplicationBun.run(middlewareApplication, {
  database: { migrations: [] },
})

const minimal = ApplicationBun.run(emptyApplication, {
  database: { migrations: [] },
  admin: true,
})

BunRuntime.runMain(complete)

// @ts-expect-error Entry points cannot run because StoragePrefix remains a requirement.
BunRuntime.runMain(missing)

// @ts-expect-error Entry points cannot run because the wire codec still requires StoragePrefix.
BunRuntime.runMain(storedTextCli)

// A missing storage service remains a caller requirement because it is not needed by the wire client.
const preservesMissing = true satisfies Equal<Effect.Services<typeof missing>, StoragePrefix>
const dischargesProvided = true satisfies Equal<Effect.Services<typeof complete>, never>

const preservesNativeRequirements = true satisfies Equal<
  Effect.Services<typeof nativeRuntime>,
  ExecutionDependency | BackgroundDependency | RoutesDependency
>


const preservesMiddlewareRequirement = true satisfies Equal<
  Effect.Services<typeof middlewareRuntime>,
  MiddlewareRequirement
>

void preservesMiddlewareRequirement
void preservesNativeRequirements
const defaultsAreRunnable = true satisfies Equal<Effect.Services<typeof minimal>, never>
const preservesWireCodec = true satisfies Equal<Effect.Services<typeof storedTextCli>, StoragePrefix>

const isolatesWire = true satisfies Equal<
  Rpc.ServicesClient<RpcGroup.Rpcs<typeof NotesApplication.group>>,
  never
>

void preservesMissing
void dischargesProvided
void defaultsAreRunnable
void isolatesWire
void preservesWireCodec
