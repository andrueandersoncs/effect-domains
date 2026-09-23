import { expect, it } from "@effect/vitest"
import { Array, Deferred, Effect, Equivalence, Fiber, Layer, Option, Schema, pipe } from "effect"
import * as CloudflareInfrastructure from "@effect-domains/alchemy/cloudflare"
import { FlyInfrastructure } from "@effect-domains/alchemy/fly"
import { RailwayInfrastructure } from "@effect-domains/alchemy/railway"
import { applicationUiExtraFiles, validateDeploymentState } from "@effect-domains/alchemy"
import { SqlClient } from "effect/unstable/sql"
import * as ApplicationBun from "effect-domains/application-bun"
import { ApplicationInfrastructure } from "effect-domains/application-infrastructure"
import { ReadingListApplication } from "@effect-domains/example-reading-list/application"
import { ReadingListInfrastructureIR } from "@effect-domains/example-reading-list/infrastructure"
import { ReadingListMigrations } from "@effect-domains/example-reading-list/migrations"
import { Infrastructure } from "effect-domains/infrastructure"
import { InfrastructureCompiler } from "effect-domains/infrastructure-compiler"
import { InfrastructureInspect } from "effect-domains/infrastructure-inspect"

const databaseOptions = {
  migrations: ReadingListMigrations,
  transactions: "interactive" as const,
  durability: "persistent" as const,
  writerTopology: "single" as const,
}

const DatabaseFileSchema = Schema.Struct({ name: Schema.String, file: Schema.String })
const DatabaseFilesSchema = Schema.Array(DatabaseFileSchema)

it("compiles application infrastructure into a canonical inspectable dependency graph", () => {
  const inspection = InfrastructureInspect.describe(ReadingListInfrastructureIR)

  expect(inspection).toMatchObject({
    name: "reading-list",
    capabilities: [
      "backups:none",
      "filesystem:durable",
      "network:public-http",
      "runtime:process",
      "transactions:interactive",
      "writer:single",
    ],
    resources: [
      {
        logicalId: "reading-list/api",
        dependencies: ["application"],
        resource: {
          kind: "HttpRuntime",
          application: {
            name: "reading-list",
            tables: ["books"],
          },
          publications: [
            { kind: "Rpc", path: "/rpc/v1" },
            { kind: "Mcp", path: "/mcp" },
            { kind: "Ui", path: "/", presentation: { title: "Reading list" } },
          ],
        },
      },
      {
        logicalId: "reading-list/application",
        resource: {
          kind: "SqliteStore",
          migrations: ["001_initial"],
          transactions: "interactive",
        },
      },
      {
        logicalId: "reading-list/public",
        dependencies: ["api"],
        resource: { kind: "PublicEndpoint", target: "api" },
      },
    ],
  })
})

it.effect("derives local runtime configuration from InfrastructureIR", () =>
  pipe(
    ApplicationInfrastructure.plan("ApplicationBun", ReadingListInfrastructureIR),
    Effect.map((plan) => {
      const options = ApplicationInfrastructure.httpOptions(plan.runtime.resource)

      expect(plan.application).toBe(ReadingListApplication)
      expect(plan.database.resource.migrations).toBe(ReadingListMigrations)

      expect(options).toMatchObject({
        rpc: { path: "/rpc/v1" },
        mcp: { path: "/mcp" },
        ui: {
          path: "/",
          presentation: {
            title: "Reading list",
            description: "Maintain a reading backlog, record progress, and rate finished books.",
          },
        },
      })

    }),
  ))

it.effect("uses in-memory SQLite for ephemeral local infrastructure", () => {
  const definition = ApplicationInfrastructure.define({
    application: ReadingListApplication,
    database: { ...databaseOptions, durability: "ephemeral" },
    http: {},
  })

  const infrastructure = InfrastructureCompiler.compile(definition)

  const program = Effect.gen(function* () {
    const databaseFile = yield* Deferred.make<string>()

    const initialize = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`PRAGMA database_list`
      const databases = yield* Schema.decodeUnknownEffect(DatabaseFilesSchema)(rows)
      const selectedDatabase = Array.findFirst(databases, ({ name }) => Equivalence.strictEqual<string>()(name, "main"))
      const main = Option.getOrThrow(selectedDatabase)

      yield* Deferred.succeed(databaseFile, main.file)
    })

    const originalArguments = Array.fromIterable(process.argv)

    const acquire = Effect.sync(() => {
      process.argv = [process.execPath, "infrastructure-ephemeral", "worker"]
    })

    const use = Effect.fn("Infrastructure.testEphemeralDatabase")(function* () {
      const runningEffect = ApplicationBun.runInfrastructure(infrastructure, {
        initialize,
        background: Layer.empty,
        telemetry: false,
      })

      const running = yield* Effect.forkScoped(runningEffect)
      const filename = yield* Deferred.await(databaseFile)

      expect(filename).toBe("")
      yield* Fiber.interrupt(running)
    })

    const release = () => Effect.sync(() => {
      process.argv = originalArguments
    })

    yield* Effect.acquireUseRelease(acquire, use, release)
  })

  return Effect.scoped(program)
})

it.effect("rejects a persistent filename for ephemeral local infrastructure", () => {
  const definition = ApplicationInfrastructure.define({
    application: ReadingListApplication,
    database: { ...databaseOptions, durability: "ephemeral" },
    http: {},
  })

  const infrastructure = InfrastructureCompiler.compile(definition)

  return pipe(
    ApplicationBun.runInfrastructure(infrastructure, {
      database: { filename: "data/should-not-exist.sqlite" },
      telemetry: false,
    }),
    Effect.flip,
    Effect.map((failure) => {
      expect(failure).toMatchObject({
        _tag: "InfrastructureDatabaseConfigurationError",
        reason: "An ephemeral infrastructure database cannot use a persistent filename",
      })
    }),
  )
})

it("maps one Reading List graph to stable Railway and Fly resource identities", () => {
  const railway = RailwayInfrastructure.make({
    infrastructure: ReadingListInfrastructureIR,
    options: { main: import.meta.url },
  })

  const fly = FlyInfrastructure.make({
    infrastructure: ReadingListInfrastructureIR,
    options: { main: import.meta.url },
  })

  const railwayEndpoint = pipe(
    railway.plan.endpoint,
    Option.map(({ logicalId }) => logicalId),
    Option.getOrUndefined,
  )

  const flyEndpoint = pipe(
    fly.plan.endpoint,
    Option.map(({ logicalId }) => logicalId),
    Option.getOrUndefined,
  )

  expect(railway.plan.runtime.logicalId).toBe("reading-list/api")
  expect(railway.plan.database.logicalId).toBe("reading-list/application")
  expect(railwayEndpoint).toBe("reading-list/public")
  expect(fly.plan.runtime.logicalId).toBe(railway.plan.runtime.logicalId)
  expect(flyEndpoint).toBe(railwayEndpoint)

  expect(railway.plan).toMatchObject({
    backend: "Railway",
    namespace: { kind: "RailwayProject", logicalId: "reading-list/namespace" },
    database: {
      kind: "RailwayVolume",
      logicalId: "reading-list/application",
      persistent: true,
      mountPath: "/data",
      filename: "application.sqlite",
    },
    runtime: {
      kind: "RailwayService",
      logicalId: "reading-list/api",
      handler: "Runtime",
      port: 3000,
      replicas: 1,
      uiAssets: true,
    },
    state: "default-local",
  })

  expect(fly.plan).toMatchObject({
    backend: "Fly",
    namespace: { kind: "FlyApp", logicalId: "reading-list/namespace" },
    database: {
      kind: "FlyMachineVolume",
      logicalId: "reading-list/application",
      persistent: true,
      mountPath: "/data",
      filename: "application.sqlite",
    },
    runtime: {
      kind: "FlyService",
      logicalId: "reading-list/api",
      handler: "Runtime",
      port: 3000,
      replicas: 1,
      uiAssets: true,
    },
    state: "default-local",
  })
})

it("rejects provider plans that cannot preserve multi-writer topology", () => {
  const definition = ApplicationInfrastructure.define({
    application: ReadingListApplication,
    database: { ...databaseOptions, writerTopology: "multiple" },
    http: {},
  })

  const infrastructure = InfrastructureCompiler.compile(definition)

  expect(() => RailwayInfrastructure.plan({
    infrastructure,
    options: { main: import.meta.url },
  })).toThrow("Railway does not support infrastructure capability writer:multiple")

  expect(() => FlyInfrastructure.plan({
    infrastructure,
    options: { main: import.meta.url },
  })).toThrow("Fly does not support infrastructure capability writer:multiple")
})

it("rejects Railway backup schedules that its provider resources cannot apply", () => {
  const lifecycle = Infrastructure.lifecycle({ backups: "daily" })

  const definition = ApplicationInfrastructure.define({
    application: ReadingListApplication,
    database: { ...databaseOptions, lifecycle },
    http: {},
  })

  const infrastructure = InfrastructureCompiler.compile(definition)

  expect(() => RailwayInfrastructure.plan({
    infrastructure,
    options: { main: import.meta.url },
  })).toThrow("Railway does not support infrastructure capability backups:daily")

  const flyPlan = FlyInfrastructure.plan({
    infrastructure,
    options: { main: import.meta.url },
  })

  expect(flyPlan.database.lifecycle.backups).toBe("daily")
})

it.effect("requires shared state for production provider stages", () =>
  pipe(
    validateDeploymentState("Railway", "production", "local"),
    Effect.flip,
    Effect.flatMap((failure) => {
      expect(failure.message).toContain("production deployments require a shared state store")

      return validateDeploymentState("Railway", "production", "postgres")
    }),
  ))

it("requires bindings to reference the exact registered descriptor", () => {
  const registered = Infrastructure.sqliteStore("application", databaseOptions)
  const replacement = Infrastructure.sqliteStore("application", databaseOptions)
  const binding = Infrastructure.readWrite({ target: replacement })

  const runtime = Infrastructure.httpRuntime("api", {
    application: ReadingListApplication,
    execution: "process",
    bindings: [binding],
  })

  const definition = Infrastructure.define({ name: "reading-list", parts: [registered, runtime] })

  expect(() => InfrastructureCompiler.compile(definition)).toThrow(
    "api references unregistered resource application",
  )
})

it("rejects non-canonical infrastructure names and resource identifiers", () => {
  const database = Infrastructure.sqliteStore(" application", databaseOptions)
  const named = Infrastructure.define({ name: "reading-list ", parts: [] })
  const identified = Infrastructure.define({ name: "reading-list", parts: [database] })

  expect(() => InfrastructureCompiler.compile(named)).toThrow(
    "Infrastructure name must not contain leading or trailing whitespace",
  )

  expect(() => InfrastructureCompiler.compile(identified)).toThrow(
    "Infrastructure resource ID  application must not contain leading or trailing whitespace",
  )
})

it("rejects duplicate publication kinds", () => {
  const database = Infrastructure.sqliteStore("application", databaseOptions)
  const binding = Infrastructure.readWrite({ target: database })
  const firstPublication = Infrastructure.rpc("/rpc/v1")
  const secondPublication = Infrastructure.rpc("/rpc/v2")

  const runtime = Infrastructure.httpRuntime("api", {
    application: ReadingListApplication,
    execution: "process",
    bindings: [binding],
    publications: [firstPublication, secondPublication],
  })

  const definition = Infrastructure.define({ name: "reading-list", parts: [database, runtime] })

  expect(() => InfrastructureCompiler.compile(definition)).toThrow(
    "Infrastructure runtime api declares RpcPublication more than once",
  )
})

it("rejects publication path collisions", () => {
  const database = Infrastructure.sqliteStore("application", databaseOptions)
  const binding = Infrastructure.readWrite({ target: database })
  const rpc = Infrastructure.rpc("/shared")
  const ui = Infrastructure.ui({ path: "/shared" })

  const runtime = Infrastructure.httpRuntime("api", {
    application: ReadingListApplication,
    execution: "process",
    bindings: [binding],
    publications: [rpc, ui],
  })

  const definition = Infrastructure.define({ name: "reading-list", parts: [database, runtime] })

  expect(() => InfrastructureCompiler.compile(definition)).toThrow(
    "Infrastructure runtime api declares publication path /shared more than once",
  )
})

it("rejects publication paths reserved by the generated UI", () => {
  const database = Infrastructure.sqliteStore("application", databaseOptions)
  const binding = Infrastructure.readWrite({ target: database })
  const mcp = Infrastructure.mcp("/api/call")
  const ui = Infrastructure.ui()

  const runtime = Infrastructure.httpRuntime("api", {
    application: ReadingListApplication,
    execution: "process",
    bindings: [binding],
    publications: [mcp, ui],
  })

  const definition = Infrastructure.define({ name: "reading-list", parts: [database, runtime] })

  expect(() => InfrastructureCompiler.compile(definition)).toThrow(
    "Infrastructure runtime api declares publication path /api/call more than once",
  )
})

it.effect("rejects Cloudflare before creating resources when transaction semantics cannot be preserved", () =>
  pipe(
    ReadingListInfrastructureIR,
    CloudflareInfrastructure.validate,
    Effect.flip,
    Effect.map((failure) => {
      expect(failure.capability).toBe("transactions:interactive")
    }),
  ))
