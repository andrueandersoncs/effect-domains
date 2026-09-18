import { retain } from "alchemy/RemovalPolicy"
import { Stack } from "alchemy/Stack"
import { App } from "alchemy/Fly/App"
import { IpAssignment } from "alchemy/Fly/IpAssignment"
import { MountVolume, MountVolumeLive } from "alchemy/Fly/MountVolume"
import { providers } from "alchemy/Fly/Providers"
import { Service } from "alchemy/Fly/Service"
import type { HttpEffect } from "alchemy/Http"
import { Data, Effect, Equivalence, Function, Match, Option, Predicate, pipe } from "effect"
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
  backupSchedules: ["none", "daily", "weekly"],
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

type FlyInfrastructureOptions = Readonly<{ main: string }> & Readonly<Partial<{
  handler: string
  orgSlug: string
  region: string
  port: number
  mountPath: string
  databaseFileName: string
  volumeSizeGb: number
  state: InfrastructureState
}>>

class FlyResolvedPlan<ApplicationPlan> extends Data.Class<{
  readonly application: ApplicationPlan
  readonly deployment: ProviderDeploymentPlan
}> {}

class FlyDeployment<Plan, AppResource, RuntimeResource, EndpointResource, StackResource> extends Data.Class<{
  readonly plan: Plan
  readonly app: AppResource
  readonly runtime: RuntimeResource
  readonly endpoint: EndpointResource
  readonly stack: StackResource
}> {}

const same = Equivalence.strictEqual<unknown>()
const NoSnapshotRetention = Option.none<number>()
const DailySnapshotRetention = Option.some(7)
const WeeklySnapshotRetention = Option.some(28)

const snapshotRetention = (schedule: "none" | "daily" | "weekly") => pipe(
  Match.value(schedule),
  Match.when("none", Function.constant(NoSnapshotRetention)),
  Match.when("daily", Function.constant(DailySnapshotRetention)),
  Match.orElse(Function.constant(WeeklySnapshotRetention)),
)

const resolvePlan = Effect.fn("FlyInfrastructure.plan")(function* ({
  infrastructure,
  options,
}: Readonly<{
  infrastructure: AnyApplicationInfrastructure
  options: FlyInfrastructureOptions
}>) {
  const application = yield* resolveApplicationPlan("Fly", capabilities, infrastructure)
  const http = ApplicationInfrastructure.httpOptions(application.runtime.resource)
  const persistent = same(application.database.resource.durability, "persistent")
  const mountPath = options.mountPath ?? "/data"
  const filename = options.databaseFileName ?? `${application.database.resource.id}.sqlite`
  const databaseKind = persistent ? "FlyMachineVolume" as const : "Memory" as const
  const configuredState = Option.fromNullishOr(options.state)

  const state = Option.match(configuredState, {
    onNone: Function.constant("default-local" as const),
    onSome: Function.constant("provided" as const),
  })

  const region = Option.some(options.region ?? "iad")
  const uiAssets = !Predicate.isBoolean(http.ui)
  const namespace = new ProviderNamespacePlan({ kind: "FlyApp", logicalId: `${application.name}/namespace` })

  const database = new ProviderDatabasePlan({
    kind: databaseKind,
    logicalId: application.database.logicalId,
    persistent,
    mountPath,
    filename,
    lifecycle: application.database.resource.lifecycle,
  })

  const runtime = new ProviderRuntimePlan({
    kind: "FlyService",
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
    Option.map(({ logicalId }) => new ProviderEndpointPlan({ kind: "FlySharedIpv4", logicalId })),
  )

  const deployment = new ProviderDeploymentPlan({
    backend: "Fly",
    name: application.name,
    namespace,
    database,
    runtime,
    endpoint,
    state,
  })

  return new FlyResolvedPlan({ application, deployment })
})

const inspectFlyPlan = (parameters: Readonly<{
  infrastructure: AnyApplicationInfrastructure
  options: FlyInfrastructureOptions
}>) => {
  const resolvedEffect = resolvePlan(parameters)
  const resolved = Effect.runSync(resolvedEffect)
  return resolved.deployment
}

const make = (parameters: Readonly<{
  infrastructure: AnyApplicationInfrastructure
  options: FlyInfrastructureOptions
}>) => {
  const resolvedEffect = resolvePlan(parameters)
  const resolved = Effect.runSync(resolvedEffect)
  const { application, deployment } = resolved
  const { options } = parameters
  const retainPolicy = Effect.map(Stack, ({ stage }) => retainedInProduction(application.database.resource, stage))

  const app = pipe(
    App(deployment.namespace.logicalId, { orgSlug: options.orgSlug }),
    retain(retainPolicy),
  )

  const retention = snapshotRetention(application.database.resource.lifecycle.backups)
  const retentionDays = Option.getOrUndefined(retention)
  const autoBackupEnabled = !same(application.database.resource.lifecycle.backups, "none")
  const http = ApplicationInfrastructure.httpOptions(application.runtime.resource)

  const runtimeProgram = pipe(
    Effect.gen(function* () {
      const databaseFile = deployment.database.persistent
        ? `${(yield* MountVolume({
          path: deployment.database.mountPath,
          sizeGb: options.volumeSizeGb ?? 1,
          name: deployment.database.logicalId,
          autoBackupEnabled,
          snapshotRetention: retentionDays,
        })).path}/${deployment.database.filename}`
        : ":memory:"

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

      return { fetch: fetch as HttpEffect }
    }),
    Effect.provide(MountVolumeLive),
  )

  const serviceRegion = Option.getOrElse(deployment.runtime.region, Function.constant("iad"))

  const runtimeService = Service(deployment.runtime.logicalId, {
    app,
    main: options.main,
    handler: deployment.runtime.handler,
    region: serviceRegion,
    count: deployment.runtime.replicas,
    port: deployment.runtime.port,
    extraFiles: deployment.runtime.uiAssets ? applicationUiExtraFiles : undefined,
    build: { install: { "better-sqlite3": "^12.6.2" } },
  }, runtimeProgram)

  const runtime = pipe(runtimeService, retain(retainPolicy))

  const endpoint = pipe(
    deployment.endpoint,
    Option.map(({ logicalId }) => IpAssignment(logicalId, { app, type: "shared_v4" })),
  )

  const stackProviders = providers()
  const configuredState = Option.fromNullishOr(options.state)
  const state = deploymentState("Fly", configuredState)
  const noEndpoint = Option.none()
  const missingEndpoint = Effect.succeed(noEndpoint)

  const stackProgram = Effect.gen(function* () {
    const deployedApp = yield* app
    const deployedRuntime = yield* runtime

    const deployedEndpoint = yield* Option.match(endpoint, {
      onNone: Function.constant(missingEndpoint),
      onSome: (address) => pipe(address, Effect.map(Option.some)),
    })

    return {
      app: deployedApp,
      database: deployment.database.persistent
        ? { logicalId: deployment.database.logicalId, mountPath: deployment.database.mountPath }
        : undefined,
      runtime: deployedRuntime,
      endpoint: Option.getOrUndefined(deployedEndpoint),
    }
  })

  const stack = Stack(application.name, { providers: stackProviders, state }, stackProgram)
  const optionalEndpoint = Option.getOrUndefined(endpoint)

  return new FlyDeployment({ plan: deployment, app, runtime, endpoint: optionalEndpoint, stack })
}

export const FlyInfrastructure = {
  capabilities,
  plan: inspectFlyPlan,
  make,
}
