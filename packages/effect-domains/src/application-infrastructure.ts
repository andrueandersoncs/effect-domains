import type { ApplicationUiPresentation } from "@effect-domains/application-ui/contract"
import { Array, Data, Effect, Equivalence, Function, Match, Option, Predicate, Schema, Struct, pipe } from "effect"

import type { ApplicationIR } from "./application.ts"
import type { ApplicationInfrastructureIR, InfrastructureIR } from "./infrastructure-compiler.ts"

import {
  type ApplicationInfrastructureSpec,
  Infrastructure,
  type HttpRuntime,
  type InfrastructureBinding,
  type InfrastructureLifecycle,
  type InfrastructurePublication,
  type InfrastructureResource,
  type PublicEndpoint,
  type RuntimeExecution,
  type SqliteStore,
  type TransactionSemantics,
  type WriterTopology,
} from "./infrastructure.ts"

import type { SqliteMigration } from "./sqlite-migration-model.ts"

type EnabledOption<Configuration extends object> = boolean | Readonly<Partial<Configuration>>

type PathOption = EnabledOption<{ path: `/${string}` }>

type UiOption = EnabledOption<{
  path: `/${string}`
  presentation: ApplicationUiPresentation
}>

type PublicOption = EnabledOption<{ id: string }>

type ApplicationInfrastructureDefinition<App extends ApplicationIR> = Readonly<{
  application: App
  database: Readonly<{ migrations: ReadonlyArray<SqliteMigration> }> & Readonly<Partial<{
    id: string
    transactions: TransactionSemantics
    durability: "ephemeral" | "persistent"
    writerTopology: WriterTopology
    lifecycle: InfrastructureLifecycle
  }>>
  http: Readonly<Partial<{
    id: string
    execution: RuntimeExecution
    bindings: ReadonlyArray<InfrastructureBinding>
    rpc: PathOption
    mcp: PathOption
    ui: UiOption
    public: PublicOption
  }>>
}> & Readonly<Partial<{ parts: ReadonlyArray<InfrastructureResource> }>>

type InfrastructureResourceIR = InfrastructureIR["resources"][number]

export class ApplicationInfrastructureError extends Schema.TaggedError<ApplicationInfrastructureError>()(
  "ApplicationInfrastructureError",
  { interpreter: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `${this.interpreter} cannot interpret this infrastructure: ${this.reason}`
  }
}

const ApplicationInfrastructureSpecBase = Data.TaggedClass("ApplicationInfrastructureSpec")

class ApplicationInfrastructureSpecValue<App extends ApplicationIR>
  extends ApplicationInfrastructureSpecBase<{
    readonly name: string
    readonly parts: ReadonlyArray<InfrastructureResource>
    readonly application: App
  }> {}

class ApplicationInfrastructurePlan<App extends ApplicationIR> extends Data.Class<{
  readonly name: string
  readonly application: App
  readonly runtime: InfrastructureResourceIR & { readonly resource: HttpRuntime }
  readonly database: InfrastructureResourceIR & { readonly resource: SqliteStore }
  readonly endpoint: Option.Option<InfrastructureResourceIR & { readonly resource: PublicEndpoint }>
}> {}

class ApplicationInfrastructureHttpOptions extends Data.Class<{
  readonly rpc: false | Readonly<{ path: `/${string}` }>
  readonly mcp: false | Readonly<{ path: `/${string}` }>
  readonly ui: false | Readonly<{ path: `/${string}`; presentation: ApplicationUiPresentation }>
}> {}


const resolveEnabled = <Configuration extends object, A>(
  option: boolean | Configuration,
  onTrue: () => A,
  onConfigured: (configuration: Configuration) => A,
): Option.Option<A> => {
  if (!Predicate.isBoolean(option)) {
    const configured = onConfigured(option)

    return Option.some(configured)
  }

  if (!option) return Option.none()

  const enabled = onTrue()

  return Option.some(enabled)
}

const configuredPath = (
  option: Option.Option<PathOption>,
  fallback: `/${string}`,
): Option.Option<`/${string}`> => {
  const resolvePath = (value: PathOption) => {
    const onTrue = () => fallback
    const onConfigured = (configuration: Exclude<PathOption, boolean>) => configuration.path ?? fallback

    return resolveEnabled(value, onTrue, onConfigured)
  }

  return Option.flatMap(option, resolvePath)
}

const pathPublications = (
  option: Option.Option<PathOption>,
  fallback: `/${string}`,
  publish: (path: `/${string}`) => InfrastructurePublication,
): ReadonlyArray<InfrastructurePublication> => {
  const path = configuredPath(option, fallback)
  const publication = Option.map(path, publish)

  return Option.toArray(publication)
}


const publications = (
  http: ApplicationInfrastructureDefinition<ApplicationIR>["http"],
): ReadonlyArray<InfrastructurePublication> => {
  const rpcOption = Option.fromNullishOr(http.rpc)
  const mcpOption = Option.fromNullishOr(http.mcp)
  const rpc = pathPublications(rpcOption, "/rpc/v1", Infrastructure.rpc)
  const mcp = pathPublications(mcpOption, "/mcp", Infrastructure.mcp)
  const uiOption = Option.fromNullishOr(http.ui)
  const enabledUi = (option: UiOption) => resolveEnabled(option, Infrastructure.ui, Infrastructure.ui)
  const uiPublication = Option.flatMap(uiOption, enabledUi)
  const ui = Option.toArray(uiPublication)
  const rpcAndMcp = Array.appendAll(rpc, mcp)

  return Array.appendAll(rpcAndMcp, ui)
}

const publicEndpoint = (
  runtime: Parameters<typeof Infrastructure.publicEndpoint>[0]["target"],
  option: PublicOption,
) => {
  const publicEndpointInput = new Data.Class({ id: "public", target: runtime })
  const defaultEndpoint = Infrastructure.publicEndpoint(publicEndpointInput)
  const onTrue = Function.constant(defaultEndpoint)

  const onConfigured = (configuration: Exclude<PublicOption, boolean>) => {
    const id = configuration.id ?? "public"
    const endpointInput = new Data.Class({ id, target: runtime })

    return Infrastructure.publicEndpoint(endpointInput)
  }

  return resolveEnabled(option, onTrue, onConfigured)
}

const define = <App extends ApplicationIR>(
  definition: ApplicationInfrastructureDefinition<App>,
): ApplicationInfrastructureSpec<App> => {
  const lifecycle = definition.database.lifecycle ?? Infrastructure.lifecycle()
  const databaseId = definition.database.id ?? "application"
  const transactions = definition.database.transactions ?? "interactive"
  const durability = definition.database.durability ?? "persistent"
  const writerTopology = definition.database.writerTopology ?? "single"

  const databaseOptions = new Data.Class({
    migrations: definition.database.migrations,
    transactions,
    durability,
    writerTopology,
    lifecycle,
  })

  const database = Infrastructure.sqliteStore(databaseId, databaseOptions)
  const readWriteInput = new Data.Class({ target: database })
  const readWrite = Infrastructure.readWrite(readWriteInput)
  const additionalBindings = definition.http.bindings ?? []
  const bindings = Array.prepend(additionalBindings, readWrite)
  const runtimePublications = publications(definition.http)
  const runtimeId = definition.http.id ?? "api"
  const execution = definition.http.execution ?? "process"

  const runtimeOptions = new Data.Class({
    application: definition.application,
    execution,
    bindings,
    publications: runtimePublications,
  })

  const runtime = Infrastructure.httpRuntime(runtimeId, runtimeOptions)
  const endpointOption = Option.fromNullishOr(definition.http.public)
  const resolveEndpoint = (option: PublicOption) => publicEndpoint(runtime, option)
  const endpoint = Option.flatMap(endpointOption, resolveEndpoint)
  const base: ReadonlyArray<InfrastructureResource> = [database, runtime]
  const endpointResources = Option.toArray(endpoint)
  const additionalParts = definition.parts ?? []
  const baseWithEndpoint = Array.appendAll(base, endpointResources)
  const parts = Array.appendAll(baseWithEndpoint, additionalParts)
  const specificationParts = Array.fromIterable(parts)

  const specification = new ApplicationInfrastructureSpecValue<App>({
    name: definition.application.name,
    parts: specificationParts,
    application: definition.application,
  })

  return Struct.assign(specification, { application: definition.application })
}

const resourceTag = <Tag extends InfrastructureResourceIR["resource"]["_tag"]>(tag: Tag) => {
  const hasTag = (
    candidate: InfrastructureResourceIR,
  ): candidate is InfrastructureResourceIR & {
    readonly resource: Extract<InfrastructureResourceIR["resource"], { readonly _tag: Tag }>
  } => Equivalence.strictEqual()(candidate.resource._tag, tag)

  return hasTag
}

const resourcesWithTag = <Tag extends InfrastructureResourceIR["resource"]["_tag"]>(
  infrastructure: InfrastructureIR,
  tag: Tag,
) => {
  const predicate = resourceTag(tag)

  return Array.filter(infrastructure.resources, predicate)
}

const isApplicationResource = (resource: InfrastructureResourceIR) =>
  pipe(
    Match.value(resource.resource._tag),
    Match.when("HttpRuntime", Function.constant(true)),
    Match.when("SqliteStore", Function.constant(true)),
    Match.when("PublicEndpoint", Function.constant(true)),
    Match.orElse(Function.constant(false)),
  )

const unsupportedResourceLabel = ({ logicalId, resource }: InfrastructureResourceIR) => `${logicalId} (${resource._tag})`
const isUnsupportedApplicationResource = (resource: InfrastructureResourceIR) => !isApplicationResource(resource)

const isSqliteBinding = (
  binding: HttpRuntime["bindings"][number],
): binding is Extract<HttpRuntime["bindings"][number], { readonly _tag: "ReadWriteSqliteBinding" }> =>
  Equivalence.strictEqual()(binding._tag, "ReadWriteSqliteBinding")

const makeOnly = Effect.fn("ApplicationInfrastructure.only")

const only = makeOnly(function* <A>(
  interpreter: string,
  kind: string,
  values: ReadonlyArray<A>,
) {
  if (!Equivalence.strictEqual()(values.length, 1)) {
    const reason = `expected exactly one ${kind}, found ${values.length}`
    const error = ApplicationInfrastructureError.make({ interpreter, reason })

    return yield* error
  }

  const head = Array.head(values)

  return Option.getOrThrow(head)
})

const makeResolvePlan = Effect.fn("ApplicationInfrastructure.plan")

const resolvePlan = makeResolvePlan(function* <App extends ApplicationIR>(
  interpreter: string,
  infrastructure: ApplicationInfrastructureIR<App>,
) {
  const unsupported = Array.filter(infrastructure.resources, isUnsupportedApplicationResource)

  if (!Equivalence.strictEqual()(unsupported.length, 0)) {
    const labels = Array.map(unsupported, unsupportedResourceLabel)
    const resources = Array.join(labels, ", ")
    const reason = `unsupported resources ${resources}`
    const error = ApplicationInfrastructureError.make({ interpreter, reason })

    return yield* error
  }

  const runtimeResources = resourcesWithTag(infrastructure, "HttpRuntime")
  const databaseResources = resourcesWithTag(infrastructure, "SqliteStore")
  const runtimeEffect = only(interpreter, "HTTP runtime", runtimeResources)
  const databaseEffect = only(interpreter, "SQLite store", databaseResources)
  const runtime = yield* runtimeEffect
  const database = yield* databaseEffect
  const endpoints = resourcesWithTag(infrastructure, "PublicEndpoint")

  if (endpoints.length > 1) {
    const reason = `expected at most one public endpoint, found ${endpoints.length}`
    const error = ApplicationInfrastructureError.make({ interpreter, reason })

    return yield* error
  }

  const sqliteBindings = Array.filter(runtime.resource.bindings, isSqliteBinding)
  const bindingReason = `${runtime.logicalId} must bind exactly once to ${database.logicalId}`

  if (!Equivalence.strictEqual()(sqliteBindings.length, 1)) {
    const error = ApplicationInfrastructureError.make({ interpreter, reason: bindingReason })

    return yield* error
  }

  const bindingOption = Array.head(sqliteBindings)
  const binding = Option.getOrThrow(bindingOption)

  if (!Equivalence.strictEqual()(binding.target, database.resource)) {
    const error = ApplicationInfrastructureError.make({ interpreter, reason: bindingReason })

    return yield* error
  }

  const endpoint = Array.head(endpoints)

  const targetsAnotherRuntime = (value: (typeof endpoints)[number]) =>
    !Equivalence.strictEqual()(value.resource.target, runtime.resource)

  const wrongTarget = Option.filter(endpoint, targetsAnotherRuntime)

  if (Option.isSome(wrongTarget)) {
    const reason = `${wrongTarget.value.logicalId} must target ${runtime.logicalId}`
    const error = ApplicationInfrastructureError.make({ interpreter, reason })

    return yield* error
  }

  return new ApplicationInfrastructurePlan<App>({
    name: infrastructure.name,
    application: infrastructure.application,
    runtime,
    database,
    endpoint,
  })
})

const publicationTag = <Tag extends InfrastructurePublication["_tag"]>(tag: Tag) => {
  const hasTag = (
    publication: InfrastructurePublication,
  ): publication is Extract<InfrastructurePublication, { readonly _tag: Tag }> =>
    Equivalence.strictEqual()(publication._tag, tag)

  return hasTag
}

const findPublication = <Tag extends InfrastructurePublication["_tag"]>(
  runtimePublications: ReadonlyArray<InfrastructurePublication>,
  tag: Tag,
) => {
  const predicate = publicationTag(tag)

  return Array.findFirst(runtimePublications, predicate)
}

type ResolvedPathOption = false | Readonly<{ path: `/${string}` }>

const publicationPath = <A extends { readonly path: `/${string}` }>(
  publication: Option.Option<A>,
): ResolvedPathOption => Option.match(publication, {
  onNone: Function.constant(false),
  onSome: (value) => new Data.Class({ path: value.path }),
})

const uiHttpOption = (
  publication: Option.Option<Extract<InfrastructurePublication, { readonly _tag: "UiPublication" }>>,
): false | Readonly<{ path: `/${string}`; presentation: ApplicationUiPresentation }> => Option.match(publication, {
  onNone: Function.constant(false),
  onSome: (value) => new Data.Class({ path: value.path, presentation: value.presentation }),
})

const httpOptions = (runtime: HttpRuntime) => {
  const rpcPublication = findPublication(runtime.publications, "RpcPublication")
  const mcpPublication = findPublication(runtime.publications, "McpPublication")
  const uiPublication = findPublication(runtime.publications, "UiPublication")
  const rpc = publicationPath(rpcPublication)
  const mcp = publicationPath(mcpPublication)
  const ui = uiHttpOption(uiPublication)
  const options = { rpc, mcp, ui }

  return new ApplicationInfrastructureHttpOptions(options)
}

export const ApplicationInfrastructure = {
  define,
  plan: resolvePlan,
  httpOptions,
}
