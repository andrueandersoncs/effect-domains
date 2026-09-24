import { Array, Data, Effect, Equivalence, Function, HashSet, Match, Option, Schema, pipe } from "effect"
import { applicationUiPaths } from "./application-ui-paths.ts"
import type { ApplicationIR } from "./application.ts"

import {
  type ApplicationInfrastructureSpec,
  type BackupSchedule,
  type InfrastructureBinding,
  type InfrastructurePublication,
  type InfrastructureResource,
  type InfrastructureSpec,
  type RuntimeExecution,
  type TransactionSemantics,
  type WriterTopology,
} from "./infrastructure.ts"

type InfrastructureDefinition = InfrastructureSpec | ApplicationInfrastructureSpec<ApplicationIR>

type InfrastructureCapability = Data.TaggedEnum<{
  RuntimeExecutionCapability: { readonly execution: RuntimeExecution }
  RelationalTransactionsCapability: { readonly transactions: TransactionSemantics }
  DurableFilesystemCapability: {}
  WriterTopologyCapability: { readonly topology: WriterTopology }
  BackupScheduleCapability: { readonly schedule: BackupSchedule }
  BackgroundLifetimeCapability: {}
  ScheduledExecutionCapability: {}
  ObjectStorageCapability: {}
  QueueCapability: { readonly delivery: "at-least-once" }
  SecretCapability: {}
  PublicHttpCapability: {}
  CustomDomainCapability: {}
  OtlpCapability: {}
  ExtensionCapability: { readonly namespace: string; readonly version: number }
}>

const Capabilities = Data.taggedEnum<InfrastructureCapability>()

class InfrastructureDefinitionError extends Schema.TaggedError<InfrastructureDefinitionError>()(
  "InfrastructureDefinitionError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

class InfrastructureResourceIR extends Data.Class<{
  readonly logicalId: string
  readonly resource: InfrastructureResource
  readonly dependencies: ReadonlyArray<InfrastructureResource>
  readonly capabilities: ReadonlyArray<InfrastructureCapability>
}> {}

type InfrastructureIRFields = Readonly<{
  name: string
  resources: ReadonlyArray<InfrastructureResourceIR>
  capabilities: ReadonlyArray<InfrastructureCapability>
}>

export class InfrastructureIR extends Data.Class<InfrastructureIRFields> {}

export class ApplicationInfrastructureIR<App extends ApplicationIR> extends Data.Class<
  InfrastructureIRFields & { readonly application: App }
> {}

const sameResource = Equivalence.strictEqual<InfrastructureResource>()
const containsResource = Array.containsWith(sameResource)
const sameDurability = Equivalence.strictEqual<"ephemeral" | "persistent">()

const NoBindings: ReadonlyArray<InfrastructureBinding> = []
const noBindings = Function.constant(NoBindings)
const NoPublications: ReadonlyArray<InfrastructurePublication> = []
const noPublications = Function.constant(NoPublications)

const bindings = (resource: InfrastructureResource) => pipe(
  Match.value(resource),
  Match.tagsExhaustive({
    HttpRuntime: ({ bindings }) => bindings,
    BackgroundRuntime: ({ bindings }) => bindings,
    ScheduledRuntime: ({ bindings }) => bindings,
    SqliteStore: noBindings,
    DurableFilesystem: noBindings,
    ObjectStore: noBindings,
    Queue: noBindings,
    Secret: noBindings,
    Variable: noBindings,
    PublicEndpoint: noBindings,
    Domain: noBindings,
    OtlpDestination: noBindings,
    Extension: noBindings,
  }),
)

const publications = (resource: InfrastructureResource) => pipe(
  Match.value(resource),
  Match.tagsExhaustive({
    HttpRuntime: ({ publications }) => publications,
    BackgroundRuntime: noPublications,
    ScheduledRuntime: noPublications,
    SqliteStore: noPublications,
    DurableFilesystem: noPublications,
    ObjectStore: noPublications,
    Queue: noPublications,
    Secret: noPublications,
    Variable: noPublications,
    PublicEndpoint: noPublications,
    Domain: noPublications,
    OtlpDestination: noPublications,
    Extension: noPublications,
  }),
)

const bindingTarget = (binding: InfrastructureBinding): InfrastructureResource => pipe(
  Match.value(binding),
  Match.tagsExhaustive({
    ReadWriteSqliteBinding: ({ target }) => target,
    ReadObjectStoreBinding: ({ target }) => target,
    WriteObjectStoreBinding: ({ target }) => target,
    ProduceQueueBinding: ({ target }) => target,
    ConsumeQueueBinding: ({ target }) => target,
    UseSecretBinding: ({ target }) => target,
    UseVariableBinding: ({ target }) => target,
    EmitTelemetryBinding: ({ target }) => target,
  }),
)

const dependencies = (resource: InfrastructureResource): ReadonlyArray<InfrastructureResource> => {
  const resourceBindings = bindings(resource)
  const bound = Array.map(resourceBindings, bindingTarget)
  const boundDependencies = Function.constant(bound)
  const noDependencies = Function.constant<ReadonlyArray<InfrastructureResource>>([])

  return pipe(
    Match.value(resource),
    Match.tagsExhaustive({
      HttpRuntime: boundDependencies,
      BackgroundRuntime: boundDependencies,
      ScheduledRuntime: boundDependencies,
      SqliteStore: noDependencies,
      DurableFilesystem: noDependencies,
      ObjectStore: noDependencies,
      Queue: noDependencies,
      Secret: noDependencies,
      Variable: noDependencies,
      PublicEndpoint: ({ target }) => [target],
      Domain: ({ target }) => [target],
      OtlpDestination: noDependencies,
      Extension: noDependencies,
    }),
  )
}

const DurableFilesystemCapabilities = [Capabilities.DurableFilesystemCapability()]
const ObjectStorageCapabilities = [Capabilities.ObjectStorageCapability()]
const SecretCapabilities = [Capabilities.SecretCapability()]
const PublicHttpCapabilities = [Capabilities.PublicHttpCapability()]
const CustomDomainCapabilities = [Capabilities.CustomDomainCapability()]
const OtlpCapabilities = [Capabilities.OtlpCapability()]
const NoCapabilities: ReadonlyArray<InfrastructureCapability> = []
const noCapabilities = Function.constant(NoCapabilities)

const queueBindingCapabilities = (
  binding: Extract<InfrastructureBinding, { readonly _tag: "ProduceQueueBinding" | "ConsumeQueueBinding" }>,
) => [Capabilities.QueueCapability({ delivery: binding.target.delivery })]

const bindingCapabilities = (binding: InfrastructureBinding): ReadonlyArray<InfrastructureCapability> => pipe(
  Match.value(binding),
  Match.tagsExhaustive({
    ReadWriteSqliteBinding: noCapabilities,
    ReadObjectStoreBinding: Function.constant(ObjectStorageCapabilities),
    WriteObjectStoreBinding: Function.constant(ObjectStorageCapabilities),
    ProduceQueueBinding: queueBindingCapabilities,
    ConsumeQueueBinding: queueBindingCapabilities,
    UseSecretBinding: Function.constant(SecretCapabilities),
    UseVariableBinding: noCapabilities,
    EmitTelemetryBinding: Function.constant(OtlpCapabilities),
  }),
)

const resourceCapabilities = (resource: InfrastructureResource): ReadonlyArray<InfrastructureCapability> => {
  const resourceBindings = bindings(resource)
  const bound = Array.flatMap(resourceBindings, bindingCapabilities)

  return pipe(
    Match.value(resource),
    Match.tagsExhaustive({
      HttpRuntime: ({ execution }) => {
        const runtime = Capabilities.RuntimeExecutionCapability({ execution })

        return Array.prepend(bound, runtime)
      },
      BackgroundRuntime: ({ execution }) => {
        const runtime = Capabilities.RuntimeExecutionCapability({ execution })
        const background = Capabilities.BackgroundLifetimeCapability()

        return Array.appendAll([runtime, background], bound)
      },
      ScheduledRuntime: ({ execution }) => {
        const runtime = Capabilities.RuntimeExecutionCapability({ execution })
        const scheduled = Capabilities.ScheduledExecutionCapability()

        return Array.appendAll([runtime, scheduled], bound)
      },
      SqliteStore: ({ durability, transactions, writerTopology, lifecycle }) => {
        const transaction = Capabilities.RelationalTransactionsCapability({ transactions })
        const durable = sameDurability(durability, "persistent") ? [Capabilities.DurableFilesystemCapability()] : []
        const writer = Capabilities.WriterTopologyCapability({ topology: writerTopology })
        const backups = Capabilities.BackupScheduleCapability({ schedule: lifecycle.backups })

        return pipe([transaction], Array.appendAll(durable), Array.append(writer), Array.append(backups))
      },
      DurableFilesystem: Function.constant(DurableFilesystemCapabilities),
      ObjectStore: Function.constant(ObjectStorageCapabilities),
      Queue: ({ delivery }) => [Capabilities.QueueCapability({ delivery })],
      Secret: Function.constant(SecretCapabilities),
      Variable: noCapabilities,
      PublicEndpoint: Function.constant(PublicHttpCapabilities),
      Domain: Function.constant(CustomDomainCapabilities),
      OtlpDestination: Function.constant(OtlpCapabilities),
      Extension: ({ namespace, version }) => [Capabilities.ExtensionCapability({ namespace, version })],
    }),
  )
}

const capabilityKey = (capability: InfrastructureCapability) => pipe(
  Match.value(capability),
  Match.tagsExhaustive({
    RuntimeExecutionCapability: ({ execution }) => `runtime:${execution}`,
    RelationalTransactionsCapability: ({ transactions }) => `transactions:${transactions}`,
    DurableFilesystemCapability: Function.constant("filesystem:durable"),
    WriterTopologyCapability: ({ topology }) => `writer:${topology}`,
    BackupScheduleCapability: ({ schedule }) => `backups:${schedule}`,
    BackgroundLifetimeCapability: Function.constant("runtime:background"),
    ScheduledExecutionCapability: Function.constant("runtime:scheduled"),
    ObjectStorageCapability: Function.constant("storage:object"),
    QueueCapability: ({ delivery }) => `queue:${delivery}`,
    SecretCapability: Function.constant("configuration:secret"),
    PublicHttpCapability: Function.constant("network:public-http"),
    CustomDomainCapability: Function.constant("network:domain"),
    OtlpCapability: Function.constant("observability:otlp"),
    ExtensionCapability: ({ namespace, version }) => `extension:${namespace}:${version}`,
  }),
)

class CapabilityAccumulator extends Data.Class<{
  readonly keys: HashSet.HashSet<string>
  readonly values: ReadonlyArray<InfrastructureCapability>
}> {}

const appendUniqueCapability = (
  state: CapabilityAccumulator,
  value: InfrastructureCapability,
): CapabilityAccumulator => {
  const key = capabilityKey(value)

  if (HashSet.has(state.keys, key)) return state

  const keys = HashSet.add(state.keys, key)
  const values = Array.append(state.values, value)

  return new CapabilityAccumulator({ keys, values })
}

const uniqueCapabilities = (values: ReadonlyArray<InfrastructureCapability>) => {
  const keys = HashSet.empty<string>()
  const initial = new CapabilityAccumulator({ keys, values: [] })
  const accumulated = Array.reduce(values, initial, appendUniqueCapability)

  return accumulated.values
}

const validateId = Effect.fn("Infrastructure.validateId")(function* (
  seen: HashSet.HashSet<string>,
  id: string,
) {
  const trimmed = id.trim()
  const empty = Equivalence.strictEqual()(trimmed.length, 0)
  const padded = !Equivalence.strictEqual()(trimmed, id)
  const duplicate = HashSet.has(seen, id)

  if (empty) {
    const error = InfrastructureDefinitionError.make({ reason: "Infrastructure resource IDs must not be empty" })

    return yield* Effect.fail(error)
  }

  if (padded) {
    const error = InfrastructureDefinitionError.make({
      reason: `Infrastructure resource ID ${id} must not contain leading or trailing whitespace`,
    })

    return yield* Effect.fail(error)
  }

  if (duplicate) {
    const error = InfrastructureDefinitionError.make({ reason: `Duplicate infrastructure resource ID ${id}` })

    return yield* Effect.fail(error)
  }

  return HashSet.add(seen, id)
})

class PublicationAccumulator extends Data.Class<{
  readonly tags: HashSet.HashSet<string>
  readonly paths: HashSet.HashSet<string>
}> {}

const publicationPaths = (publication: InfrastructurePublication): ReadonlyArray<string> => pipe(
  Match.value(publication),
  Match.tagsExhaustive({
    RpcPublication: ({ path }) => [path],
    McpPublication: ({ path }) => [path],
    UiPublication: ({ path }) => {
      const paths = applicationUiPaths(path)

      return [paths.document, paths.javascript, paths.stylesheet, paths.api, paths.call]
    },
  }),
)

const validatePublication = (
  runtime: InfrastructureResource,
) => Effect.fn("Infrastructure.validatePublication")(function* (
  state: PublicationAccumulator,
  publication: InfrastructurePublication,
) {
  if (HashSet.has(state.tags, publication._tag)) {
    return yield* InfrastructureDefinitionError.make({
      reason: `Infrastructure runtime ${runtime.id} declares ${publication._tag} more than once`,
    })
  }

  const occupiedPaths = publicationPaths(publication)
  const collision = Array.findFirst(occupiedPaths, (path) => HashSet.has(state.paths, path))

  if (Option.isSome(collision)) {
    return yield* InfrastructureDefinitionError.make({
      reason: `Infrastructure runtime ${runtime.id} declares publication path ${collision.value} more than once`,
    })
  }

  const tags = HashSet.add(state.tags, publication._tag)
  const paths = Array.reduce(occupiedPaths, state.paths, (paths, path) => HashSet.add(paths, path))

  return new PublicationAccumulator({ tags, paths })
})

const validatePublications = Effect.fn("Infrastructure.validatePublications")(function* (
  resource: InfrastructureResource,
) {
  const tags = HashSet.empty<string>()
  const paths = HashSet.empty<string>()
  const initial = new PublicationAccumulator({ tags, paths })
  const resourcePublications = publications(resource)
  const initialState = Function.constant(initial)

  yield* Effect.reduce(resourcePublications, initialState, validatePublication(resource))
})

const validateResourceDependencies = (
  resources: ReadonlyArray<InfrastructureResource>,
) => Effect.fn("Infrastructure.validateDependencies")(function* (resource: InfrastructureResource) {
  const resourceDependencies = dependencies(resource)

  const validateDependency = Effect.fn("Infrastructure.validateDependency")(function* (
    dependency: InfrastructureResource,
  ) {
    if (!containsResource(resources, dependency)) {
      return yield* InfrastructureDefinitionError.make({
        reason: `Infrastructure resource ${resource.id} references unregistered resource ${dependency.id}; use the registered descriptor`,
      })
    }
  })

  yield* Effect.forEach(resourceDependencies, validateDependency, { discard: true })
})

const validateCycle: (
  resource: InfrastructureResource,
  visiting: HashSet.HashSet<string>,
  visited: HashSet.HashSet<string>,
) => Effect.Effect<HashSet.HashSet<string>, InfrastructureDefinitionError> = Effect.fn("Infrastructure.validateCycle")(
  function* (resource, visiting, visited) {
    if (HashSet.has(visited, resource.id)) return visited

    if (HashSet.has(visiting, resource.id)) {
      return yield* InfrastructureDefinitionError.make({
        reason: `Infrastructure dependency cycle includes ${resource.id}`,
      })
    }

    const nextVisiting = HashSet.add(visiting, resource.id)
    const resourceDependencies = dependencies(resource)

    const nextVisited = yield* Effect.reduce(
      resourceDependencies,
      () => visited,
      Effect.fn("Infrastructure.validateCycleDependency")(function* (state, dependency) {
        return yield* validateCycle(dependency, nextVisiting, state)
      }),
    )

    return HashSet.add(nextVisited, resource.id)
  },
)

const validateDefinition = Effect.fn("Infrastructure.validate")(function* (
  definition: InfrastructureDefinition,
) {
  const name = definition.name.trim()

  if (Equivalence.strictEqual()(name.length, 0)) {
    return yield* InfrastructureDefinitionError.make({
      reason: "Infrastructure name must not be empty",
    })
  }

  if (!Equivalence.strictEqual()(name, definition.name)) {
    return yield* InfrastructureDefinitionError.make({
      reason: "Infrastructure name must not contain leading or trailing whitespace",
    })
  }

  const ids = Array.map(definition.parts, ({ id }) => id)

  yield* Effect.reduce(ids, HashSet.empty<string>, validateId)
  yield* Effect.forEach(definition.parts, validateResourceDependencies(definition.parts), { discard: true })
  yield* Effect.forEach(definition.parts, validatePublications, { discard: true })

  yield* Effect.reduce(
    definition.parts,
    HashSet.empty<string>,
    Effect.fn("Infrastructure.validateRootCycle")(function* (visited, resource) {
      const visiting = HashSet.empty<string>()

      return yield* validateCycle(resource, visiting, visited)
    }),
  )

  return definition.parts
})

const compileResource = (name: string) => (resource: InfrastructureResource) => {
  const resourceDependencies = dependencies(resource)
  const requiredCapabilities = resourceCapabilities(resource)
  const capabilities = uniqueCapabilities(requiredCapabilities)
  const compiledDependencies = Array.fromIterable(resourceDependencies)

  return new InfrastructureResourceIR({
    logicalId: `${name}/${resource.id}`,
    resource,
    dependencies: compiledDependencies,
    capabilities,
  })
}

function compile<App extends ApplicationIR>(
  definition: ApplicationInfrastructureSpec<App>,
): ApplicationInfrastructureIR<App>

function compile(definition: InfrastructureSpec): InfrastructureIR

function compile(definition: InfrastructureDefinition) {
  const validation = validateDefinition(definition)
  const resources = Effect.runSync(validation)
  const compiled = Array.map(resources, compileResource(definition.name))
  const nestedCapabilities = Array.flatMap(compiled, ({ capabilities }) => capabilities)
  const capabilities = uniqueCapabilities(nestedCapabilities)
  const compiledResources = Array.fromIterable(compiled)

  return pipe(
    Match.value(definition),
    Match.when({ _tag: "ApplicationInfrastructureSpec" }, (definition) => new ApplicationInfrastructureIR({
      name: definition.name,
      resources: compiledResources,
      capabilities,
      application: definition.application,
    })),
    Match.orElse((definition) => new InfrastructureIR({
      name: definition.name,
      resources: compiledResources,
      capabilities,
    })),
  )
}

export const InfrastructureCompiler = {
  compile,
  capabilityKey,
}
