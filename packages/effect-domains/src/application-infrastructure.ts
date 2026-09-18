import type { ApplicationUiPresentation } from "@effect-domains/application-ui/contract"
import { Array, Data, Effect, Equivalence, Function, Match, Option, Predicate, Schema, pipe } from "effect"

import type { ApplicationIR } from "./application.ts"
import type { ApplicationInfrastructureIR, InfrastructureIR } from "./infrastructure-compiler.ts"

import {
  ApplicationInfrastructureSpec,
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

type PathOption = boolean | Readonly<Partial<{ path: `/${string}` }>>

type UiOption = boolean | Readonly<Partial<{
  path: `/${string}`
  presentation: ApplicationUiPresentation
}>>

type PublicOption = boolean | Readonly<Partial<{ id: string }>>

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

const same = Equivalence.strictEqual<unknown>()

const resolvePath = (fallback: `/${string}`) => (value: PathOption) => {
  if (Predicate.isBoolean(value)) {
    return value ? Option.some(fallback) : Option.none()
  }

  return Option.some(value.path ?? fallback)
}

const configuredPath = (
  option: Option.Option<PathOption>,
  fallback: `/${string}`,
) => pipe(option, Option.flatMap(resolvePath(fallback)))

const uiPublication = (option: UiOption) => Predicate.isBoolean(option)
  ? Infrastructure.ui()
  : Infrastructure.ui(option)

const enabledUi = (option: UiOption) => {
  const publication = uiPublication(option)
  if (Predicate.isBoolean(option)) return option ? Option.some(publication) : Option.none()
  return Option.some(publication)
}

const publications = (
  http: ApplicationInfrastructureDefinition<ApplicationIR>["http"],
): ReadonlyArray<InfrastructurePublication> => {
  const rpcOption = Option.fromNullishOr(http.rpc)
  const mcpOption = Option.fromNullishOr(http.mcp)
  const rpcPath = configuredPath(rpcOption, "/rpc/v1")
  const mcpPath = configuredPath(mcpOption, "/mcp")
  const rpc = pipe(rpcPath, Option.map(Infrastructure.rpc), Option.toArray)
  const mcp = pipe(mcpPath, Option.map(Infrastructure.mcp), Option.toArray)
  const ui = pipe(Option.fromNullishOr(http.ui), Option.flatMap(enabledUi), Option.toArray)

  return pipe(rpc, Array.appendAll(mcp), Array.appendAll(ui))
}

const publicEndpoint = (
  runtime: Parameters<typeof Infrastructure.publicEndpoint>[0]["target"],
  option: PublicOption,
) => {
  if (Predicate.isBoolean(option)) {
    const endpoint = Infrastructure.publicEndpoint({ id: "public", target: runtime })
    return option ? Option.some(endpoint) : Option.none()
  }

  const endpoint = Infrastructure.publicEndpoint({ id: option.id ?? "public", target: runtime })
  return Option.some(endpoint)
}

const define = <App extends ApplicationIR>(definition: ApplicationInfrastructureDefinition<App>): ApplicationInfrastructureSpec<App> => {
  const lifecycle = definition.database.lifecycle ?? Infrastructure.lifecycle()

  const database = Infrastructure.sqliteStore(definition.database.id ?? "application", {
    migrations: definition.database.migrations,
    transactions: definition.database.transactions ?? "interactive",
    durability: definition.database.durability ?? "persistent",
    writerTopology: definition.database.writerTopology ?? "single",
    lifecycle,
  })

  const readWrite = Infrastructure.readWrite({ target: database })
  const additionalBindings = definition.http.bindings ?? []
  const bindings = Array.prepend(additionalBindings, readWrite)
  const runtimePublications = publications(definition.http)

  const runtime = Infrastructure.httpRuntime(definition.http.id ?? "api", {
    application: definition.application,
    execution: definition.http.execution ?? "process",
    bindings,
    publications: runtimePublications,
  })

  const endpointOption = Option.fromNullishOr(definition.http.public)
  const endpoint = pipe(endpointOption, Option.flatMap((option) => publicEndpoint(runtime, option)))
  const base = [database, runtime]
  const endpointResources = Option.toArray(endpoint)
  const additionalParts = definition.parts ?? []
  const parts = pipe(base, Array.appendAll(endpointResources), Array.appendAll(additionalParts))
  const specificationParts = Array.fromIterable(parts)

  return new ApplicationInfrastructureSpec({
    _tag: "ApplicationInfrastructureSpec",
    name: definition.application.name,
    parts: specificationParts,
    application: definition.application,
  })
}

const resourceTag = <Tag extends InfrastructureResourceIR["resource"]["_tag"]>(tag: Tag) => (
  resource: InfrastructureResourceIR,
): resource is InfrastructureResourceIR & {
  readonly resource: Extract<InfrastructureResourceIR["resource"], { readonly _tag: Tag }>
} => same(resource.resource._tag, tag)

const resourcesWithTag = <Tag extends InfrastructureResourceIR["resource"]["_tag"]>(
  infrastructure: InfrastructureIR,
  tag: Tag,
) => Array.filter(infrastructure.resources, resourceTag(tag))

const isApplicationResource = (resource: InfrastructureResourceIR) => pipe(
  Match.value(resource.resource),
  Match.tagsExhaustive({
    HttpRuntime: Function.constant(true),
    BackgroundRuntime: Function.constant(false),
    ScheduledRuntime: Function.constant(false),
    SqliteStore: Function.constant(true),
    DurableFilesystem: Function.constant(false),
    ObjectStore: Function.constant(false),
    Queue: Function.constant(false),
    Secret: Function.constant(false),
    Variable: Function.constant(false),
    PublicEndpoint: Function.constant(true),
    Domain: Function.constant(false),
    OtlpDestination: Function.constant(false),
    Extension: Function.constant(false),
  }),
)

const unsupportedResourceLabel = ({ logicalId, resource }: InfrastructureResourceIR) => `${logicalId} (${resource._tag})`
const isUnsupportedApplicationResource = (resource: InfrastructureResourceIR) => !isApplicationResource(resource)

const isSqliteBinding = (
  binding: HttpRuntime["bindings"][number],
): binding is Extract<HttpRuntime["bindings"][number], { readonly _tag: "ReadWriteSqliteBinding" }> =>
  same(binding._tag, "ReadWriteSqliteBinding")

const only = Effect.fn("ApplicationInfrastructure.only")(function* <A>(
  interpreter: string,
  kind: string,
  values: ReadonlyArray<A>,
) {
  if (!same(values.length, 1)) {
    return yield* ApplicationInfrastructureError.make({
      interpreter,
      reason: `expected exactly one ${kind}, found ${values.length}`,
    })
  }

  return yield* pipe(
    Array.head(values),
    Effect.fromOption,
    Effect.mapError(() => ApplicationInfrastructureError.make({ interpreter, reason: `missing ${kind}` })),
  )
})

const resolvePlan = Effect.fn("ApplicationInfrastructure.plan")(function* <App extends ApplicationIR>(
  interpreter: string,
  infrastructure: ApplicationInfrastructureIR<App>,
) {
  const unsupported = Array.filter(infrastructure.resources, isUnsupportedApplicationResource)

  if (!same(unsupported.length, 0)) {
    const labels = Array.map(unsupported, unsupportedResourceLabel)
    const resources = Array.join(labels, ", ")
    return yield* ApplicationInfrastructureError.make({ interpreter, reason: `unsupported resources ${resources}` })
  }

  const runtimeResources = resourcesWithTag(infrastructure, "HttpRuntime")
  const databaseResources = resourcesWithTag(infrastructure, "SqliteStore")
  const runtime = yield* only(interpreter, "HTTP runtime", runtimeResources)
  const database = yield* only(interpreter, "SQLite store", databaseResources)
  const endpoints = resourcesWithTag(infrastructure, "PublicEndpoint")

  if (endpoints.length > 1) {
    return yield* ApplicationInfrastructureError.make({
      interpreter,
      reason: `expected at most one public endpoint, found ${endpoints.length}`,
    })
  }

  const sqliteBindings = Array.filter(runtime.resource.bindings, isSqliteBinding)
  const binding = Array.head(sqliteBindings)
  const hasOneBinding = same(sqliteBindings.length, 1)

  const targetsDatabase = pipe(
    binding,
    Option.map(({ target }) => same(target, database.resource)),
    Option.getOrElse(Function.constant(false)),
  )

  const missingBinding = !hasOneBinding
  const wrongTarget = !targetsDatabase
  const invalidBinding = missingBinding || wrongTarget

  if (invalidBinding) {
    return yield* ApplicationInfrastructureError.make({
      interpreter,
      reason: `${runtime.logicalId} must bind exactly once to ${database.logicalId}`,
    })
  }

  const endpoint = Array.head(endpoints)

  const endpointTargetsRuntime = pipe(
    endpoint,
    Option.map(({ resource }) => same(resource.target, runtime.resource)),
    Option.getOrElse(Function.constant(true)),
  )

  if (!endpointTargetsRuntime) {
    const logicalId = pipe(endpoint, Option.map(({ logicalId }) => logicalId), Option.getOrElse(Function.constant("public endpoint")))
    return yield* ApplicationInfrastructureError.make({ interpreter, reason: `${logicalId} must target ${runtime.logicalId}` })
  }

  return new ApplicationInfrastructurePlan<App>({
    name: infrastructure.name,
    application: infrastructure.application,
    runtime,
    database,
    endpoint,
  })
})

const publicationTag = <Tag extends InfrastructurePublication["_tag"]>(tag: Tag) => (
  publication: InfrastructurePublication,
): publication is Extract<InfrastructurePublication, { readonly _tag: Tag }> => same(publication._tag, tag)

const findPublication = <Tag extends InfrastructurePublication["_tag"]>(
  runtimePublications: ReadonlyArray<InfrastructurePublication>,
  tag: Tag,
) => Array.findFirst(runtimePublications, publicationTag(tag))

const httpOptions = (runtime: HttpRuntime) => {
  const rpcPublication = findPublication(runtime.publications, "RpcPublication")
  const mcpPublication = findPublication(runtime.publications, "McpPublication")
  const uiPublication = findPublication(runtime.publications, "UiPublication")

  const rpc = pipe(
    rpcPublication,
    Option.match({ onNone: Function.constant(false as const), onSome: ({ path }) => ({ path }) }),
  )

  const mcp = pipe(
    mcpPublication,
    Option.match({ onNone: Function.constant(false as const), onSome: ({ path }) => ({ path }) }),
  )

  const ui = pipe(
    uiPublication,
    Option.match({
      onNone: Function.constant(false as const),
      onSome: ({ path, presentation }) => ({ path, presentation }),
    }),
  )

  return new ApplicationInfrastructureHttpOptions({ rpc, mcp, ui })
}

export const ApplicationInfrastructure = {
  define,
  plan: Effect.fn("ApplicationInfrastructure.plan")(function* <App extends ApplicationIR>(
    interpreter: string,
    infrastructure: ApplicationInfrastructureIR<App>,
  ) {
    return yield* resolvePlan(interpreter, infrastructure)
  }),
  httpOptions,
}
