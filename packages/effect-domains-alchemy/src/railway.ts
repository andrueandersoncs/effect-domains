import { retain } from "alchemy/RemovalPolicy"
import { Stack } from "alchemy/Stack"
import { MountVolume, MountVolumeLive } from "alchemy/Railway/MountVolume"
import { Project } from "alchemy/Railway/Project"
import { providers } from "alchemy/Railway/Providers"
import { Service } from "alchemy/Railway/Service"
import { Volume } from "alchemy/Railway/Volume"
import type { HttpEffect } from "alchemy/Http"
import { Data, Effect, Equivalence, Function, Option, Predicate, pipe } from "effect"
import { ApplicationInfrastructure } from "effect-domains/application-infrastructure"
import * as ApplicationRuntime from "effect-domains/application-runtime"
import { SqliteNodeRuntime } from "effect-domains/sqlite-node"

import {
  type AnyApplicationInfrastructure,
  applicationUiExtraFiles,
  deploymentState,
  type InfrastructureBackendCapabilities,
  type InfrastructureState,
  loadApplicationUiAssets,
  ProviderDatabasePlan,
  ProviderDeploymentPlan,
  ProviderEndpointPlan,
  ProviderNamespacePlan,
  ProviderRuntimePlan,
  resolveApplicationPlan,
  retainedInProduction,
} from "./backend.ts"

const capabilities: InfrastructureBackendCapabilities = {
  execution: ["process"],
  transactions: ["batch", "interactive"],
  durableFilesystem: true,
  writerTopologies: ["single"],
  backupSchedules: ["none"],
  backgroundLifetime: false,
  scheduledExecution: false,
  objectStorage: false,
  queue: false,
  secrets: false,
  publicHttp: true,
  customDomains: false,
  otlp: false,
  extensions: [],
}

type RailwayInfrastructureOptions = Readonly<{ main: string }> & Readonly<Partial<{
  handler: string
  region: string
  port: number
  mountPath: string
  databaseFileName: string
  state: InfrastructureState
}>>

class RailwayResolvedPlan<ApplicationPlan> extends Data.Class<{
  readonly application: ApplicationPlan
  readonly deployment: ProviderDeploymentPlan
}> {}

class RailwayDeployment<Plan, ProjectResource, VolumeResource, RuntimeResource, StackResource> extends Data.Class<{
  readonly plan: Plan
  readonly project: ProjectResource
  readonly volume: VolumeResource
  readonly runtime: RuntimeResource
  readonly stack: StackResource
}> {}

const same = Equivalence.strictEqual<unknown>()

const resolvePlan = Effect.fn("RailwayInfrastructure.plan")(function* ({
  infrastructure,
  options,
}: Readonly<{
  infrastructure: AnyApplicationInfrastructure
  options: RailwayInfrastructureOptions
}>) {
  const application = yield* resolveApplicationPlan("Railway", capabilities, infrastructure)
  const http = ApplicationInfrastructure.httpOptions(application.runtime.resource)
  const persistent = same(application.database.resource.durability, "persistent")
  const mountPath = options.mountPath ?? "/data"
  const filename = options.databaseFileName ?? `${application.database.resource.id}.sqlite`
  const databaseKind = persistent ? "RailwayVolume" as const : "Memory" as const
  const configuredState = Option.fromNullishOr(options.state)

  const state = Option.match(configuredState, {
    onNone: Function.constant("default-local" as const),
    onSome: Function.constant("provided" as const),
  })

  const region = Option.fromNullishOr(options.region)
  const uiAssets = !Predicate.isBoolean(http.ui)
  const namespace = new ProviderNamespacePlan({ kind: "RailwayProject", logicalId: `${application.name}/namespace` })

  const database = new ProviderDatabasePlan({
    kind: databaseKind,
    logicalId: application.database.logicalId,
    persistent,
    mountPath,
    filename,
    lifecycle: application.database.resource.lifecycle,
  })

  const runtime = new ProviderRuntimePlan({
    kind: "RailwayService",
    logicalId: application.runtime.logicalId,
    handler: options.handler ?? "Runtime",
    port: options.port ?? 3000,
    region,
    replicas: 1,
    uiAssets,
    publications: application.runtime.resource.publications,
  })

  const endpoint = pipe(
    application.endpoint,
    Option.map(({ logicalId }) => new ProviderEndpointPlan({ kind: "RailwayDomain", logicalId })),
  )

  const deployment = new ProviderDeploymentPlan({
    backend: "Railway",
    name: application.name,
    namespace,
    database,
    runtime,
    endpoint,
    state,
  })

  return new RailwayResolvedPlan({ application, deployment })
})

const inspectRailwayPlan = (parameters: Readonly<{
  infrastructure: AnyApplicationInfrastructure
  options: RailwayInfrastructureOptions
}>) => {
  const resolvedEffect = resolvePlan(parameters)
  const resolved = Effect.runSync(resolvedEffect)

  return resolved.deployment
}

const make = (parameters: Readonly<{
  infrastructure: AnyApplicationInfrastructure
  options: RailwayInfrastructureOptions
}>) => {
  const resolvedEffect = resolvePlan(parameters)
  const resolved = Effect.runSync(resolvedEffect)
  const { application, deployment } = resolved
  const { options } = parameters

  const project = Project(deployment.namespace.logicalId, {
    description: `${application.name} infrastructure managed by Effect Domains`,
  })

  const retainVolume = Effect.map(Stack, ({ stage }) => retainedInProduction(application.database.resource, stage))
  const volumeRegion = Option.getOrUndefined(deployment.runtime.region)

  const configuredVolume = () => pipe(
    Volume(deployment.database.logicalId, {
      project,
      mountPath: deployment.database.mountPath,
      region: volumeRegion,
    }),
    retain(retainVolume),
    Option.some,
  )

  const volume = deployment.database.persistent ? configuredVolume() : Option.none()
  const http = ApplicationInfrastructure.httpOptions(application.runtime.resource)
  const memoryDatabase = Effect.succeed(":memory:")

  const runtimeProgram = pipe(
    Effect.gen(function* () {
      const databaseFile = yield* Option.match(volume, {
        onNone: Function.constant(memoryDatabase),
        onSome: Effect.fn("RailwayInfrastructure.mountVolume")(function* (databaseVolume) {
          const mounted = yield* MountVolume(databaseVolume, { path: deployment.database.mountPath })

          return `${mounted.path}/${deployment.database.filename}`
        }),
      })

      const noAssets = Option.none<Readonly<{ javascript: string; stylesheet: string }>>()
      const disabledAssets = Effect.succeed(noAssets)
      const enabledAssets = pipe(loadApplicationUiAssets(), Effect.map(Option.some), Effect.orDie)
      const assets = yield* (deployment.runtime.uiAssets ? enabledAssets : disabledAssets)
      const database = SqliteNodeRuntime.sqlClient(databaseFile, { migrations: application.database.resource.migrations })
      const uiAssets = Option.getOrUndefined(assets)

      const fetch = yield* pipe(
        ApplicationRuntime.httpEffect(
          application.application,
          database,
          {
            ...http,
            uiAssets,
            telemetry: false,
          },
        ),
        Effect.orDie,
      )

      // SAFETY: The asserted infrastructure type matches because this branch constructs the corresponding provider declaration.
      return { fetch: fetch as HttpEffect }
    }),
    Effect.provide(MountVolumeLive),
  )

  const publicDomain = Option.isSome(deployment.endpoint)
  const runtimeRegion = Option.getOrUndefined(deployment.runtime.region)

  const runtime = Service(deployment.runtime.logicalId, {
    project,
    main: options.main,
    handler: deployment.runtime.handler,
    port: deployment.runtime.port,
    publicDomain,
    region: runtimeRegion,
    extraFiles: deployment.runtime.uiAssets ? applicationUiExtraFiles : undefined,
    build: { install: { "better-sqlite3": "^12.6.2" } },
  }, runtimeProgram)

  const stackProviders = providers()
  const configuredState = Option.fromNullishOr(options.state)
  const state = deploymentState("Railway", configuredState)
  const noDatabase = Option.none()
  const missingDatabase = Effect.succeed(noDatabase)

  const stackProgram = Effect.gen(function* () {
    const deployedProject = yield* project

    const deployedDatabase = yield* Option.match(volume, {
      onNone: Function.constant(missingDatabase),
      onSome: (databaseVolume) => pipe(databaseVolume, Effect.map(Option.some)),
    })

    const deployedRuntime = yield* runtime
    const endpoint = pipe(deployment.endpoint, Option.map(Function.constant(deployedRuntime.url)), Option.getOrUndefined)

    return {
      project: deployedProject,
      database: Option.getOrUndefined(deployedDatabase),
      runtime: deployedRuntime,
      endpoint,
    }
  })

  const stack = Stack(application.name, { providers: stackProviders, state }, stackProgram)
  const optionalVolume = Option.getOrUndefined(volume)

  return new RailwayDeployment({ plan: deployment, project, volume: optionalVolume, runtime, stack })
}

export const RailwayInfrastructure = {
  capabilities,
  plan: inspectRailwayPlan,
  make,
}
