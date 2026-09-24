import type { ApplicationUiPresentation } from "@effect-domains/application-ui/contract"
import { Array, Data, Option, Struct } from "effect"
import type { ApplicationIR } from "./application.ts"
import type { SqliteMigration } from "./sqlite-migration-model.ts"

export type TransactionSemantics = "batch" | "interactive"
export type RuntimeExecution = "process" | "request"
export type WriterTopology = "single" | "multiple"

type RemovalPolicy = "destroy" | "retain"
export type BackupSchedule = "none" | "daily" | "weekly"

export class InfrastructureLifecycle extends Data.Class<{
  readonly productionRemoval: RemovalPolicy
  readonly backups: BackupSchedule
}> {}

export type InfrastructurePublication = Data.TaggedEnum<{
  RpcPublication: { readonly path: `/${string}` }
  McpPublication: { readonly path: `/${string}` }
  UiPublication: {
    readonly path: `/${string}`
    readonly presentation: ApplicationUiPresentation
  }
}>

const Publications = Data.taggedEnum<InfrastructurePublication>()

export type InfrastructureBinding = Data.TaggedEnum<{
  ReadWriteSqliteBinding: { readonly target: SqliteStore }
  ReadObjectStoreBinding: { readonly target: ObjectStore }
  WriteObjectStoreBinding: { readonly target: ObjectStore }
  ProduceQueueBinding: { readonly target: Queue }
  ConsumeQueueBinding: { readonly target: Queue }
  UseSecretBinding: { readonly target: Secret }
  UseVariableBinding: { readonly target: Variable }
  EmitTelemetryBinding: { readonly target: OtlpDestination }
}>

const Bindings = Data.taggedEnum<InfrastructureBinding>()

export type InfrastructureResource = Data.TaggedEnum<{
  HttpRuntime: {
    readonly id: string
    readonly application: ApplicationIR
    readonly execution: RuntimeExecution
    readonly bindings: ReadonlyArray<InfrastructureBinding>
    readonly publications: ReadonlyArray<InfrastructurePublication>
  }
  BackgroundRuntime: {
    readonly id: string
    readonly application: ApplicationIR
    readonly execution: RuntimeExecution
    readonly bindings: ReadonlyArray<InfrastructureBinding>
  }
  ScheduledRuntime: {
    readonly id: string
    readonly application: ApplicationIR
    readonly execution: RuntimeExecution
    readonly schedule: string
    readonly bindings: ReadonlyArray<InfrastructureBinding>
  }
  SqliteStore: {
    readonly id: string
    readonly migrations: ReadonlyArray<SqliteMigration>
    readonly transactions: TransactionSemantics
    readonly durability: "ephemeral" | "persistent"
    readonly writerTopology: WriterTopology
    readonly lifecycle: InfrastructureLifecycle
  }
  DurableFilesystem: {
    readonly id: string
    readonly lifecycle: InfrastructureLifecycle
  }
  ObjectStore: {
    readonly id: string
    readonly lifecycle: InfrastructureLifecycle
  }
  Queue: {
    readonly id: string
    readonly delivery: "at-least-once"
  }
  Secret: {
    readonly id: string
    readonly configurationKey: string
  }
  Variable: {
    readonly id: string
    readonly configurationKey: string
    readonly defaultValue: Option.Option<string>
  }
  PublicEndpoint: {
    readonly id: string
    readonly target: HttpRuntime
  }
  Domain: {
    readonly id: string
    readonly name: string
    readonly target: PublicEndpoint
  }
  OtlpDestination: {
    readonly id: string
    readonly endpointConfigurationKey: string
  }
  Extension: {
    readonly id: string
    readonly namespace: string
    readonly version: number
    readonly configuration: unknown
  }
}>

const Resources = Data.taggedEnum<InfrastructureResource>()

export type HttpRuntime = Extract<InfrastructureResource, { readonly _tag: "HttpRuntime" }>
export type BackgroundRuntime = Extract<InfrastructureResource, { readonly _tag: "BackgroundRuntime" }>
export type ScheduledRuntime = Extract<InfrastructureResource, { readonly _tag: "ScheduledRuntime" }>
export type SqliteStore = Extract<InfrastructureResource, { readonly _tag: "SqliteStore" }>
export type DurableFilesystem = Extract<InfrastructureResource, { readonly _tag: "DurableFilesystem" }>
export type ObjectStore = Extract<InfrastructureResource, { readonly _tag: "ObjectStore" }>
export type Queue = Extract<InfrastructureResource, { readonly _tag: "Queue" }>
export type Secret = Extract<InfrastructureResource, { readonly _tag: "Secret" }>
export type Variable = Extract<InfrastructureResource, { readonly _tag: "Variable" }>
export type PublicEndpoint = Extract<InfrastructureResource, { readonly _tag: "PublicEndpoint" }>
export type Domain = Extract<InfrastructureResource, { readonly _tag: "Domain" }>
export type OtlpDestination = Extract<InfrastructureResource, { readonly _tag: "OtlpDestination" }>
export type Extension = Extract<InfrastructureResource, { readonly _tag: "Extension" }>

export type InfrastructureSpec = Data.TaggedEnum<{
  InfrastructureSpec: {
    readonly name: string
    readonly parts: ReadonlyArray<InfrastructureResource>
  }
}>

export type ApplicationInfrastructureSpec<App extends ApplicationIR> = Data.TaggedEnum<{
  ApplicationInfrastructureSpec: {
    readonly name: string
    readonly parts: ReadonlyArray<InfrastructureResource>
    readonly application: App
  }
}>

const InfrastructureSpecs = Data.taggedEnum<InfrastructureSpec>()

const define = (
  definition: Readonly<{ name: string; parts: ReadonlyArray<InfrastructureResource> }>,
) => {
  const parts = Array.fromIterable(definition.parts)

  return InfrastructureSpecs.InfrastructureSpec({ name: definition.name, parts })
}

const lifecycle = (
  options: Readonly<Partial<InfrastructureLifecycle>> = {},
) => new InfrastructureLifecycle({
  productionRemoval: options.productionRemoval ?? "retain",
  backups: options.backups ?? "none",
})

const sqliteStore = (
  id: string,
  options: Readonly<{
    migrations: ReadonlyArray<SqliteMigration>
    transactions: TransactionSemantics
    durability: "ephemeral" | "persistent"
    writerTopology: WriterTopology
  }> & Readonly<Partial<{ lifecycle: InfrastructureLifecycle }>>,
) => {
  const migrations = Array.fromIterable(options.migrations)
  const resourceLifecycle = options.lifecycle ?? lifecycle()

  return Resources.SqliteStore({
    id,
    migrations,
    transactions: options.transactions,
    durability: options.durability,
    writerTopology: options.writerTopology,
    lifecycle: resourceLifecycle,
  })
}

const httpRuntime = (
  id: string,
  options: Readonly<{
    application: ApplicationIR
    execution: RuntimeExecution
  }> & Readonly<Partial<{
    bindings: ReadonlyArray<InfrastructureBinding>
    publications: ReadonlyArray<InfrastructurePublication>
  }>>,
) => {
  const bindings = Array.fromIterable(options.bindings ?? [])
  const publications = Array.fromIterable(options.publications ?? [])

  return Resources.HttpRuntime({
    id,
    application: options.application,
    execution: options.execution,
    bindings,
    publications,
  })
}

const backgroundRuntime = (
  id: string,
  options: Readonly<{
    application: ApplicationIR
    execution: RuntimeExecution
  }> & Readonly<Partial<{ bindings: ReadonlyArray<InfrastructureBinding> }>>,
) => {
  const bindings = Array.fromIterable(options.bindings ?? [])

  return Resources.BackgroundRuntime({ id, application: options.application, execution: options.execution, bindings })
}

const scheduledRuntime = (
  id: string,
  options: Readonly<{
    application: ApplicationIR
    execution: RuntimeExecution
    schedule: string
  }> & Readonly<Partial<{ bindings: ReadonlyArray<InfrastructureBinding> }>>,
) => {
  const bindings = Array.fromIterable(options.bindings ?? [])

  return Resources.ScheduledRuntime({
    id,
    application: options.application,
    execution: options.execution,
    schedule: options.schedule,
    bindings,
  })
}

const durableFilesystem = (
  id: string,
  options: Readonly<Partial<{ lifecycle: InfrastructureLifecycle }>> = {},
) => {
  const resourceLifecycle = options.lifecycle ?? lifecycle()

  return Resources.DurableFilesystem({ id, lifecycle: resourceLifecycle })
}

const objectStore = (
  id: string,
  options: Readonly<Partial<{ lifecycle: InfrastructureLifecycle }>> = {},
) => {
  const resourceLifecycle = options.lifecycle ?? lifecycle()

  return Resources.ObjectStore({ id, lifecycle: resourceLifecycle })
}

const queue = (id: string) => Resources.Queue({ id, delivery: "at-least-once" })

const variable = (
  id: string,
  configurationKey: string,
  options: Readonly<Partial<{ defaultValue: string }>> = {},
) => {
  const defaultValue = Option.fromNullishOr(options.defaultValue)

  return Resources.Variable({ id, configurationKey, defaultValue })
}

const publicationPath = Struct.get<InfrastructurePublication, "path">("path")
const resourceLifecycle = Struct.get<DurableFilesystem | ObjectStore, "lifecycle">("lifecycle")
const configurationKey = Struct.get<Secret | Variable, "configurationKey">("configurationKey")
const variableDefaultValue = Struct.get<Variable, "defaultValue">("defaultValue")
const target = Struct.get<PublicEndpoint | Domain, "target">("target")
const otlpConfigurationKey = Struct.get<OtlpDestination, "endpointConfigurationKey">("endpointConfigurationKey")
const extensionNamespace = Struct.get<Extension, "namespace">("namespace")
const extensionVersion = Struct.get<Extension, "version">("version")
const extensionConfiguration = Struct.get<Extension, "configuration">("configuration")

const rpc = (path: `/${string}` = "/rpc/v1"): InfrastructurePublication => Publications.RpcPublication({ path })
const mcp = (path: `/${string}` = "/mcp"): InfrastructurePublication => Publications.McpPublication({ path })

const ui = (
  options: Readonly<Partial<{
    path: `/${string}`
    presentation: ApplicationUiPresentation
  }>> = {},
): InfrastructurePublication => Publications.UiPublication({
  path: options.path ?? "/",
  presentation: options.presentation ?? {},
})

export const Infrastructure = {
  define,
  lifecycle,
  httpRuntime,
  backgroundRuntime,
  scheduledRuntime,
  sqliteStore,
  durableFilesystem,
  objectStore,
  queue,
  secret: Resources.Secret,
  variable,
  publicEndpoint: Resources.PublicEndpoint,
  domain: Resources.Domain,
  otlpDestination: Resources.OtlpDestination,
  extension: Resources.Extension,
  rpc,
  mcp,
  ui,
  readWrite: Bindings.ReadWriteSqliteBinding,
  publicationPath,
  resourceLifecycle,
  configurationKey,
  variableDefaultValue,
  target,
  otlpConfigurationKey,
  extensionNamespace,
  extensionVersion,
  extensionConfiguration,
  readObjectStore: Bindings.ReadObjectStoreBinding,
  writeObjectStore: Bindings.WriteObjectStoreBinding,
  produce: Bindings.ProduceQueueBinding,
  consume: Bindings.ConsumeQueueBinding,
  useSecret: Bindings.UseSecretBinding,
  useVariable: Bindings.UseVariableBinding,
  emitTelemetry: Bindings.EmitTelemetryBinding,
}
