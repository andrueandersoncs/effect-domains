import { Array, Match, Order, Record, Schema, pipe } from "effect"

import { Infrastructure, type InfrastructureBinding, type InfrastructurePublication, type InfrastructureResource } from "./infrastructure.ts"
import { InfrastructureCompiler, type InfrastructureIR } from "./infrastructure-compiler.ts"

const BindingInspectionSchema = Schema.Struct({ kind: Schema.String, target: Schema.String })

const RpcPublicationInspectionSchema = Schema.Struct({ kind: Schema.Literal("Rpc"), path: Schema.String })
const McpPublicationInspectionSchema = Schema.Struct({ kind: Schema.Literal("Mcp"), path: Schema.String })

const UiPublicationInspectionSchema = Schema.Struct({
  kind: Schema.Literal("Ui"),
  path: Schema.String,
  presentation: Schema.Unknown,
})

const ApplicationInspectionSchema = Schema.Struct({
  name: Schema.String,
  operations: Schema.Array(Schema.String),
  tables: Schema.Array(Schema.String),
})

const HttpRuntimeInspectionSchema = Schema.Struct({
  kind: Schema.Literal("HttpRuntime"),
  id: Schema.String,
  execution: Schema.String,
  application: ApplicationInspectionSchema,
  bindings: Schema.Array(BindingInspectionSchema),
  publications: Schema.Array(Schema.Union([
    RpcPublicationInspectionSchema,
    McpPublicationInspectionSchema,
    UiPublicationInspectionSchema,
  ])),
})

const BackgroundRuntimeInspectionSchema = Schema.Struct({
  kind: Schema.Literal("BackgroundRuntime"),
  id: Schema.String,
  execution: Schema.String,
  application: ApplicationInspectionSchema,
  bindings: Schema.Array(BindingInspectionSchema),
})

const ScheduledRuntimeInspectionSchema = Schema.Struct({
  kind: Schema.Literal("ScheduledRuntime"),
  id: Schema.String,
  execution: Schema.String,
  schedule: Schema.String,
  application: ApplicationInspectionSchema,
  bindings: Schema.Array(BindingInspectionSchema),
})

const SqliteStoreInspectionSchema = Schema.Struct({
  kind: Schema.Literal("SqliteStore"),
  id: Schema.String,
  migrations: Schema.Array(Schema.String),
  transactions: Schema.String,
  durability: Schema.String,
  writerTopology: Schema.String,
  lifecycle: Schema.Unknown,
})

const LifecycleResourceInspectionSchema = Schema.Struct({
  kind: Schema.String,
  id: Schema.String,
  lifecycle: Schema.Unknown,
})

const QueueInspectionSchema = Schema.Struct({ kind: Schema.Literal("Queue"), id: Schema.String, delivery: Schema.String })
const ConfigurationInspectionSchema = Schema.Struct({ kind: Schema.String, id: Schema.String, configurationKey: Schema.String })

const VariableInspectionSchema = Schema.Struct({
  kind: Schema.Literal("Variable"),
  id: Schema.String,
  configurationKey: Schema.String,
  defaultValue: Schema.optionalKey(Schema.String),
})

const TargetInspectionSchema = Schema.Struct({ kind: Schema.String, id: Schema.String, target: Schema.String })
const DomainInspectionSchema = Schema.Struct({ kind: Schema.Literal("Domain"), id: Schema.String, name: Schema.String, target: Schema.String })

const ExtensionInspectionSchema = Schema.Struct({
  kind: Schema.Literal("Extension"),
  id: Schema.String,
  namespace: Schema.String,
  version: Schema.Number,
  configuration: Schema.Unknown,
})

const CompiledResourceInspectionSchema = Schema.Struct({
  logicalId: Schema.String,
  dependencies: Schema.Array(Schema.String),
  capabilities: Schema.Array(Schema.String),
  resource: Schema.Unknown,
})

const InfrastructureInspectionSchema = Schema.Struct({
  name: Schema.String,
  capabilities: Schema.Array(Schema.String),
  resources: Schema.Array(CompiledResourceInspectionSchema),
})

const binding = (value: InfrastructureBinding) => pipe(
  Match.value(value),
  Match.tagsExhaustive({
    ReadWriteSqliteBinding: ({ target }) => BindingInspectionSchema.make({ kind: "ReadWriteSqlite", target: target.id }),
    ReadObjectStoreBinding: ({ target }) => BindingInspectionSchema.make({ kind: "ReadObjectStore", target: target.id }),
    WriteObjectStoreBinding: ({ target }) => BindingInspectionSchema.make({ kind: "WriteObjectStore", target: target.id }),
    ProduceQueueBinding: ({ target }) => BindingInspectionSchema.make({ kind: "ProduceQueue", target: target.id }),
    ConsumeQueueBinding: ({ target }) => BindingInspectionSchema.make({ kind: "ConsumeQueue", target: target.id }),
    UseSecretBinding: ({ target }) => BindingInspectionSchema.make({ kind: "UseSecret", target: target.id }),
    UseVariableBinding: ({ target }) => BindingInspectionSchema.make({ kind: "UseVariable", target: target.id }),
    EmitTelemetryBinding: ({ target }) => BindingInspectionSchema.make({ kind: "EmitTelemetry", target: target.id }),
  }),
)

const publication = (value: InfrastructurePublication) => pipe(
  Match.value(value),
  Match.tagsExhaustive({
    RpcPublication: (publication) => RpcPublicationInspectionSchema.make({
      kind: "Rpc",
      path: Infrastructure.publicationPath(publication),
    }),
    McpPublication: (publication) => McpPublicationInspectionSchema.make({
      kind: "Mcp",
      path: Infrastructure.publicationPath(publication),
    }),
    UiPublication: (publication) => UiPublicationInspectionSchema.make({
      kind: "Ui",
      path: Infrastructure.publicationPath(publication),
      presentation: publication.presentation,
    }),
  }),
)

const application = (resource: Extract<InfrastructureResource, {
  readonly _tag: "HttpRuntime" | "BackgroundRuntime" | "ScheduledRuntime"
}>) => {
  const requests = resource.application.group.requests.values()
  const operations = pipe(requests, Array.fromIterable, Array.map(({ _tag }) => _tag), Array.sort(Order.String))
  const tables = pipe(resource.application.tables, Array.map(({ name }) => name), Array.sort(Order.String))

  return ApplicationInspectionSchema.make({ name: resource.application.name, operations, tables })
}

const inspectResource = (value: InfrastructureResource): unknown => pipe(
  Match.value(value),
  Match.tagsExhaustive({
    HttpRuntime: (runtime) => HttpRuntimeInspectionSchema.make({
      kind: "HttpRuntime",
      id: runtime.id,
      execution: runtime.execution,
      application: application(runtime),
      bindings: Array.map(runtime.bindings, binding),
      publications: Array.map(runtime.publications, publication),
    }),
    BackgroundRuntime: (runtime) => BackgroundRuntimeInspectionSchema.make({
      kind: "BackgroundRuntime",
      id: runtime.id,
      execution: runtime.execution,
      application: application(runtime),
      bindings: Array.map(runtime.bindings, binding),
    }),
    ScheduledRuntime: (runtime) => ScheduledRuntimeInspectionSchema.make({
      kind: "ScheduledRuntime",
      id: runtime.id,
      execution: runtime.execution,
      schedule: runtime.schedule,
      application: application(runtime),
      bindings: Array.map(runtime.bindings, binding),
    }),
    SqliteStore: (store) => SqliteStoreInspectionSchema.make({
      kind: "SqliteStore",
      id: store.id,
      migrations: Array.map(store.migrations, ({ id }) => id),
      transactions: store.transactions,
      durability: store.durability,
      writerTopology: store.writerTopology,
      lifecycle: store.lifecycle,
    }),
    DurableFilesystem: (resource) => LifecycleResourceInspectionSchema.make({
      kind: "DurableFilesystem",
      id: resource.id,
      lifecycle: Infrastructure.resourceLifecycle(resource),
    }),
    ObjectStore: (resource) => LifecycleResourceInspectionSchema.make({
      kind: "ObjectStore",
      id: resource.id,
      lifecycle: Infrastructure.resourceLifecycle(resource),
    }),
    Queue: ({ id, delivery }) => QueueInspectionSchema.make({ kind: "Queue", id, delivery }),
    Secret: (resource) => ConfigurationInspectionSchema.make({
      kind: "Secret",
      id: resource.id,
      configurationKey: Infrastructure.configurationKey(resource),
    }),
    Variable: (resource) => {
      const defaultValue = Infrastructure.variableDefaultValue(resource)
      const defaults = Record.getSomes({ defaultValue })

      return VariableInspectionSchema.make({
        kind: "Variable",
        id: resource.id,
        configurationKey: Infrastructure.configurationKey(resource),
        ...defaults,
      })
    },
    PublicEndpoint: (resource) => {
      const target = Infrastructure.target(resource)
      return TargetInspectionSchema.make({ kind: "PublicEndpoint", id: resource.id, target: target.id })
    },
    Domain: (resource) => {
      const target = Infrastructure.target(resource)
      return DomainInspectionSchema.make({ kind: "Domain", id: resource.id, name: resource.name, target: target.id })
    },
    OtlpDestination: (resource) => ConfigurationInspectionSchema.make({
      kind: "OtlpDestination",
      id: resource.id,
      configurationKey: Infrastructure.otlpConfigurationKey(resource),
    }),
    Extension: (resource) => ExtensionInspectionSchema.make({
      kind: "Extension",
      id: resource.id,
      namespace: Infrastructure.extensionNamespace(resource),
      version: Infrastructure.extensionVersion(resource),
      configuration: Infrastructure.extensionConfiguration(resource),
    }),
  }),
)

const describe = (infrastructure: InfrastructureIR) => {
  const capabilities = pipe(infrastructure.capabilities, Array.map(InfrastructureCompiler.capabilityKey), Array.sort(Order.String))
  const sortedResources = Array.sortWith(infrastructure.resources, ({ logicalId }) => logicalId, Order.String)

  const resources = Array.map(sortedResources, (compiled) => {
    const dependencies = pipe(compiled.dependencies, Array.map(({ id }) => id), Array.sort(Order.String))
    const requiredCapabilities = pipe(compiled.capabilities, Array.map(InfrastructureCompiler.capabilityKey), Array.sort(Order.String))

    return CompiledResourceInspectionSchema.make({
      logicalId: compiled.logicalId,
      dependencies,
      capabilities: requiredCapabilities,
      resource: inspectResource(compiled.resource),
    })
  })

  return InfrastructureInspectionSchema.make({ name: infrastructure.name, capabilities, resources })
}

export const InfrastructureInspect = { describe }
