import type { ApplicationUiPresentation } from "@effect-domains/application-ui/contract"
import { Array, Data, Effect, Option, Predicate, Schema, Struct } from "effect"

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

import type { SqliteMigration } from "./sqlite-migrations.ts"

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
  if (Predicate.isBoolean(option)) {
    if (!option) return Option.none()

    const value = onTrue()
    return Option.some(value)
  }

  const value = onConfigured(option)
  return Option.some(value)
}

const configuredPath = (
  option: PathOption | undefined,
  fallback: `/${string}`,
): Option.Option<`/${string}`> => {
  if (option === undefined) return Option.none()

  const onTrue = () => fallback
  const onConfigured = (configuration: Exclude<PathOption, boolean>) => configuration.path ?? fallback

  return resolveEnabled(option, onTrue, onConfigured)
}

const pathPublications = (
  option: PathOption | undefined,
  fallback: `/${string}`,
  publish: (path: `/${string}`) => InfrastructurePublication,
): ReadonlyArray<InfrastructurePublication> => {
  const path = configuredPath(option, fallback)
  const publication = Option.map(path, publish)

  return Option.toArray(publication)
}

const enabledUi = (option: UiOption) => {
  const onTrue = () => Infrastructure.ui()
  const onConfigured = (configuration: Exclude<UiOption, boolean>) => Infrastructure.ui(configuration)

  return resolveEnabled(option, onTrue, onConfigured)
}

const publications = (
  http: ApplicationInfrastructureDefinition<ApplicationIR>["http"],
): ReadonlyArray<InfrastructurePublication> => {
  const rpc = pathPublications(http.rpc, "/rpc/v1", Infrastructure.rpc)
  const mcp = pathPublications(http.mcp, "/mcp", Infrastructure.mcp)
  const uiOption = Option.fromNullishOr(http.ui)
  const uiPublication = Option.flatMap(uiOption, enabledUi)
  const ui = Option.toArray(uiPublication)
  const rpcAndMcp = Array.appendAll(rpc, mcp)

  return Array.appendAll(rpcAndMcp, ui)
}

const publicEndpoint = (
  runtime: Parameters<typeof Infrastructure.publicEndpoint>[0]["target"],
  option: PublicOption,
) => {
  const onTrue = () => {
    const endpointInput = { id: "public", target: runtime }
    return Infrastructure.publicEndpoint(endpointInput)
  }

  const onConfigured = (configuration: Exclude<PublicOption, boolean>) => {
    const id = configuration.id ?? "public"
    const endpointInput = { id, target: runtime }

    return Infrastructure.publicEndpoint(endpointInput)
  }

  return resolveEnabled(option, onTrue, onConfigured)
}

const define = <App extends ApplicationIR>(
  definition: ApplicationInfrastructureDefinition<App>,
): ApplicationInfrastructureSpec<App> => {
  const application = definition.application
  const databaseDefinition = definition.database
  const httpDefinition = definition.http
  const lifecycle = databaseDefinition.lifecycle ?? Infrastructure.lifecycle()
  const databaseId = databaseDefinition.id ?? "application"
  const transactions = databaseDefinition.transactions ?? "interactive"
  const durability = databaseDefinition.durability ?? "persistent"
  const writerTopology = databaseDefinition.writerTopology ?? "single"
  const databaseOptions = {
    migrations: databaseDefinition.migrations,
    transactions,
    durability,
    writerTopology,
    lifecycle,
  }
  const database = Infrastructure.sqliteStore(databaseId, databaseOptions)
  const readWriteInput = { target: database }
  const readWrite = Infrastructure.readWrite(readWriteInput)
  const additionalBindings = httpDefinition.bindings ?? []
  const bindings = Array.prepend(additionalBindings, readWrite)
  const runtimePublications = publications(httpDefinition)
  const runtimeId = httpDefinition.id ?? "api"
  const execution = httpDefinition.execution ?? "process"
  const runtimeOptions = {
    application,
    execution,
    bindings,
    publications: runtimePublications,
  }
  const runtime = Infrastructure.httpRuntime(runtimeId, runtimeOptions)
  const endpointOption = Option.fromNullishOr(httpDefinition.public)
  const resolveEndpoint = (option: PublicOption) => publicEndpoint(runtime, option)
  const endpoint = Option.flatMap(endpointOption, resolveEndpoint)
  const base: ReadonlyArray<InfrastructureResource> = [database, runtime]
  const endpointResources = Option.toArray(endpoint)
  const additionalParts = definition.parts ?? []
  const baseWithEndpoint = Array.appendAll(base, endpointResources)
  const parts = Array.appendAll(baseWithEndpoint, additionalParts)
  const specificationParts = Array.fromIterable(parts)
  const specificationInput = {
    name: application.name,
    parts: specificationParts,
    application,
  }
  const specification = new ApplicationInfrastructureSpecValue<App>(specificationInput)
  const assignment = { application }

  return Struct.assign(specification, assignment)
}

const resourceTag = <Tag extends InfrastructureResourceIR["resource"]["_tag"]>(tag: Tag) => {
  const hasTag = (
    candidate: InfrastructureResourceIR,
  ): candidate is InfrastructureResourceIR & {
    readonly resource: Extract<InfrastructureResourceIR["resource"], { readonly _tag: Tag }>
  } => {
    const resource = candidate.resource
    return resource._tag === tag
  }

  return hasTag
}

const resourcesWithTag = <Tag extends InfrastructureResourceIR["resource"]["_tag"]>(
  infrastructure: InfrastructureIR,
  tag: Tag,
) => {
  const predicate = resourceTag(tag)
  return Array.filter(infrastructure.resources, predicate)
}

const isApplicationResource = (resource: InfrastructureResourceIR) => {
  const tag = resource.resource._tag

  switch (tag) {
    case "HttpRuntime":
    case "SqliteStore":
    case "PublicEndpoint":
      return true
    default:
      return false
  }
}

const unsupportedResourceLabel = ({ logicalId, resource }: InfrastructureResourceIR) => `${logicalId} (${resource._tag})`
const isUnsupportedApplicationResource = (resource: InfrastructureResourceIR) => !isApplicationResource(resource)

const isSqliteBinding = (
  binding: HttpRuntime["bindings"][number],
): binding is Extract<HttpRuntime["bindings"][number], { readonly _tag: "ReadWriteSqliteBinding" }> =>
  binding._tag === "ReadWriteSqliteBinding"

const makeOnly = Effect.fn("ApplicationInfrastructure.only")

const only = makeOnly(function* <A>(
  interpreter: string,
  kind: string,
  values: ReadonlyArray<A>,
) {
  if (values.length !== 1) {
    const reason = `expected exactly one ${kind}, found ${values.length}`
    const error = ApplicationInfrastructureError.make({ interpreter, reason })
    return yield* error
  }

  // SAFETY: The exact-length guard above proves index zero exists.
  return values[0] as A
})

const makeResolvePlan = Effect.fn("ApplicationInfrastructure.plan")

const resolvePlan = makeResolvePlan(function* <App extends ApplicationIR>(
  interpreter: string,
  infrastructure: ApplicationInfrastructureIR<App>,
) {
  const infrastructureResources = infrastructure.resources
  const unsupported = Array.filter(infrastructureResources, isUnsupportedApplicationResource)

  if (unsupported.length !== 0) {
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
    const count = endpoints.length
    const reason = `expected at most one public endpoint, found ${count}`
    const error = ApplicationInfrastructureError.make({ interpreter, reason })
    return yield* error
  }

  const runtimeResource = runtime.resource
  const sqliteBindings = Array.filter(runtimeResource.bindings, isSqliteBinding)
  const bindingReason = `${runtime.logicalId} must bind exactly once to ${database.logicalId}`

  if (sqliteBindings.length !== 1) {
    const error = ApplicationInfrastructureError.make({ interpreter, reason: bindingReason })
    return yield* error
  }

  // SAFETY: The exact-length guard above proves index zero exists.
  const binding = sqliteBindings[0] as typeof sqliteBindings[number]

  if (binding.target !== database.resource) {
    const error = ApplicationInfrastructureError.make({ interpreter, reason: bindingReason })
    return yield* error
  }

  const endpoint = Array.head(endpoints)

  if (Option.isSome(endpoint)) {
    const endpointResource = endpoint.value

    if (endpointResource.resource.target !== runtimeResource) {
      const reason = `${endpointResource.logicalId} must target ${runtime.logicalId}`
      const error = ApplicationInfrastructureError.make({ interpreter, reason })
      return yield* error
    }
  }

  const planInput = {
    name: infrastructure.name,
    application: infrastructure.application,
    runtime,
    database,
    endpoint,
  }

  return new ApplicationInfrastructurePlan<App>(planInput)
})

const publicationTag = <Tag extends InfrastructurePublication["_tag"]>(tag: Tag) => {
  const hasTag = (
    publication: InfrastructurePublication,
  ): publication is Extract<InfrastructurePublication, { readonly _tag: Tag }> => {
    const actualTag = publication._tag
    return actualTag === tag
  }

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
): ResolvedPathOption => {
  if (Option.isNone(publication)) return false

  const value = publication.value
  return { path: value.path }
}

const uiHttpOption = (
  publication: Option.Option<Extract<InfrastructurePublication, { readonly _tag: "UiPublication" }>>,
): false | Readonly<{ path: `/${string}`; presentation: ApplicationUiPresentation }> => {
  if (Option.isNone(publication)) return false

  const value = publication.value
  return { path: value.path, presentation: value.presentation }
}

const httpOptions = (runtime: HttpRuntime) => {
  const runtimePublications = runtime.publications
  const rpcPublication = findPublication(runtimePublications, "RpcPublication")
  const mcpPublication = findPublication(runtimePublications, "McpPublication")
  const uiPublication = findPublication(runtimePublications, "UiPublication")
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
