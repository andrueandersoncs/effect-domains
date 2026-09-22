import { ApplicationUiAssetFiles } from "@effect-domains/application-ui/assets"
import { Stack, type StackServices } from "alchemy/Stack"
import { localState, State } from "alchemy/State/index"
import { Array, Context, Data, Effect, Equivalence, FileSystem, Function, Layer, Match, Option, Schema, pipe } from "effect"

import { ApplicationInfrastructure } from "effect-domains/application-infrastructure"
import type { ApplicationIR } from "effect-domains/application"

import type {
  BackupSchedule,
  InfrastructureLifecycle,
  InfrastructurePublication,
  RuntimeExecution,
  SqliteStore,
  TransactionSemantics,
  WriterTopology,
} from "effect-domains/infrastructure"

import { InfrastructureCompiler, type ApplicationInfrastructureIR, type InfrastructureIR } from "effect-domains/infrastructure-compiler"

type InfrastructureCapability = InfrastructureIR["capabilities"][number]

export type AnyApplicationInfrastructure = ApplicationInfrastructureIR<ApplicationIR>

export type InfrastructureBackendCapabilities = Readonly<{
  execution: ReadonlyArray<RuntimeExecution>
  transactions: ReadonlyArray<TransactionSemantics>
  durableFilesystem: boolean
  writerTopologies: ReadonlyArray<WriterTopology>
  backupSchedules: ReadonlyArray<BackupSchedule>
  backgroundLifetime: boolean
  scheduledExecution: boolean
  objectStorage: boolean
  queue: boolean
  secrets: boolean
  publicHttp: boolean
  customDomains: boolean
  otlp: boolean
  extensions: ReadonlyArray<Readonly<{ namespace: string; versions: ReadonlyArray<number> }>>
}>

export type InfrastructureState = Layer.Layer<State, never, StackServices>

class UnsupportedInfrastructureCapability extends Schema.TaggedError<UnsupportedInfrastructureCapability>()(
  "UnsupportedInfrastructureCapability",
  { backend: Schema.String, capability: Schema.String },
) {
  override get message() {
    return `${this.backend} does not support infrastructure capability ${this.capability}`
  }
}

class ProductionStateRequired extends Schema.TaggedError<ProductionStateRequired>()(
  "ProductionStateRequired",
  { backend: Schema.String, stateStore: Schema.String },
) {
  override get message() {
    return `${this.backend} production deployments require a shared state store; received ${this.stateStore}`
  }
}

class ApplicationUiAssets extends Data.Class<{
  readonly javascript: string
  readonly stylesheet: string
}> {}

export class ProviderNamespacePlan extends Data.Class<{
  readonly kind: "RailwayProject" | "FlyApp"
  readonly logicalId: string
}> {}

export class ProviderDatabasePlan extends Data.Class<{
  readonly kind: "RailwayVolume" | "FlyMachineVolume" | "Memory"
  readonly logicalId: string
  readonly persistent: boolean
  readonly mountPath: string
  readonly filename: string
  readonly lifecycle: InfrastructureLifecycle
}> {}

export class ProviderRuntimePlan extends Data.Class<{
  readonly kind: "RailwayService" | "FlyService"
  readonly logicalId: string
  readonly handler: string
  readonly port: number
  readonly region: Option.Option<string>
  readonly replicas: number
  readonly uiAssets: boolean
  readonly publications: ReadonlyArray<InfrastructurePublication>
}> {}

export class ProviderEndpointPlan extends Data.Class<{
  readonly kind: "RailwayDomain" | "FlySharedIpv4"
  readonly logicalId: string
}> {}

export class ProviderDeploymentPlan extends Data.Class<{
  readonly backend: "Railway" | "Fly"
  readonly name: string
  readonly namespace: ProviderNamespacePlan
  readonly database: ProviderDatabasePlan
  readonly runtime: ProviderRuntimePlan
  readonly endpoint: Option.Option<ProviderEndpointPlan>
  readonly state: "default-local" | "provided"
}> {}

const ApplicationUiAssetPaths = {
  javascript: "/app/application-ui/client.js",
  stylesheet: "/app/application-ui/style.css",
} as const

export const applicationUiExtraFiles = [
  { source: ApplicationUiAssetFiles.javascript.pathname, dest: "application-ui/client.js" },
  { source: ApplicationUiAssetFiles.stylesheet.pathname, dest: "application-ui/style.css" },
] as const

export const loadApplicationUiAssets = Effect.fn("AlchemyBackend.loadApplicationUiAssets")(function* () {
  const files = yield* FileSystem.FileSystem
  const javascriptEffect = files.readFileString(ApplicationUiAssetPaths.javascript)
  const stylesheetEffect = files.readFileString(ApplicationUiAssetPaths.stylesheet)
  const [javascript, stylesheet] = yield* Effect.all([javascriptEffect, stylesheetEffect])

  return new ApplicationUiAssets({ javascript, stylesheet })
})

const same = Equivalence.strictEqual<unknown>()
const contains = <A>(values: ReadonlyArray<A>, value: A) => Array.some(values, (candidate) => same(candidate, value))

const supportsExtension = (
  capabilities: InfrastructureBackendCapabilities,
  namespace: string,
  version: number,
) => {
  const supportedVersion = (candidate: number) => same(candidate, version)

  const supportedExtension = (extension: InfrastructureBackendCapabilities["extensions"][number]) => {
    const matchingNamespace = same(extension.namespace, namespace)
    const matchingVersion = Array.some(extension.versions, supportedVersion)

    return matchingNamespace && matchingVersion
  }

  return Array.some(capabilities.extensions, supportedExtension)
}

const supported = (
  capabilities: InfrastructureBackendCapabilities,
  capability: InfrastructureCapability,
) => pipe(
  Match.value(capability),
  Match.tagsExhaustive({
    RuntimeExecutionCapability: ({ execution }) => contains(capabilities.execution, execution),
    RelationalTransactionsCapability: ({ transactions }) => contains(capabilities.transactions, transactions),
    DurableFilesystemCapability: Function.constant(capabilities.durableFilesystem),
    WriterTopologyCapability: ({ topology }) => contains(capabilities.writerTopologies, topology),
    BackupScheduleCapability: ({ schedule }) => contains(capabilities.backupSchedules, schedule),
    BackgroundLifetimeCapability: Function.constant(capabilities.backgroundLifetime),
    ScheduledExecutionCapability: Function.constant(capabilities.scheduledExecution),
    ObjectStorageCapability: Function.constant(capabilities.objectStorage),
    QueueCapability: Function.constant(capabilities.queue),
    SecretCapability: Function.constant(capabilities.secrets),
    PublicHttpCapability: Function.constant(capabilities.publicHttp),
    CustomDomainCapability: Function.constant(capabilities.customDomains),
    OtlpCapability: Function.constant(capabilities.otlp),
    ExtensionCapability: ({ namespace, version }) => supportsExtension(capabilities, namespace, version),
  }),
)

export const validateCapabilities = Effect.fn("InfrastructureBackend.validate")(function* (
  backend: string,
  capabilities: InfrastructureBackendCapabilities,
  infrastructure: InfrastructureIR,
) {
  yield* Effect.forEach(infrastructure.capabilities, Effect.fn("InfrastructureBackend.validateCapability")(function* (capability) {
    if (!supported(capabilities, capability)) {
      return yield* UnsupportedInfrastructureCapability.make({
        backend,
        capability: InfrastructureCompiler.capabilityKey(capability),
      })
    }
  }), { discard: true })
})

export const resolveApplicationPlan = Effect.fn("InfrastructureBackend.resolveApplicationPlan")(function* (
  backend: string,
  capabilities: InfrastructureBackendCapabilities,
  infrastructure: AnyApplicationInfrastructure,
) {
  yield* validateCapabilities(backend, capabilities, infrastructure)

  return yield* ApplicationInfrastructure.plan(backend, infrastructure)
})

export const validateDeploymentState = Effect.fn("InfrastructureBackend.validateDeploymentState")(function* (
  backend: string,
  stage: string,
  stateStore: string,
) {
  const production = same(stage, "production")
  const local = same(stateStore, "local")
  const invalid = production && local

  if (invalid) {
    return yield* ProductionStateRequired.make({ backend, stateStore })
  }
})

const validateState = (backend: string) => Effect.fn("InfrastructureBackend.validateState")(function* (
  context: Context.Context<State>,
) {
  const { stage } = yield* Stack
  const service = yield* Context.get(context, State)

  yield* pipe(validateDeploymentState(backend, stage, service.id), Effect.orDie)
})

export const deploymentState = (
  backend: string,
  configured: Option.Option<InfrastructureState>,
) => pipe(
  configured,
  Option.getOrElse(localState),
  Layer.tap(validateState(backend)),
)

export const retainedInProduction = (
  database: SqliteStore,
  stage: string,
) => {
  const production = same(stage, "production")
  const retained = same(database.lifecycle.productionRemoval, "retain")

  return production && retained
}
