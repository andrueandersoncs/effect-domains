import { Data, Effect, Layer, Schema } from "effect"
import type { ApplicationIR } from "./application.ts"
import { runApplication, type RunErrors, type RunRequirements } from "./application-bun-runtime.ts"
import { ApplicationInfrastructure, type ApplicationInfrastructureError } from "./application-infrastructure.ts"
import type { ApplicationHttpOptions, Initialization, RuntimeLayer } from "./application-runtime.ts"
import type { ApplicationInfrastructureIR } from "./infrastructure-compiler.ts"
import type { SqliteMigration } from "./sqlite-migrations.ts"

class InfrastructureDatabaseOptions extends Data.Class<Readonly<{
  migrations: ReadonlyArray<SqliteMigration>
}>> {}

class InfrastructureFileDatabaseOptions extends Data.Class<Readonly<{
  migrations: ReadonlyArray<SqliteMigration>
  filename: string
}>> {}

type InfrastructureRunOptions<
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
  Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
> = Omit<
  ApplicationHttpOptions<Services, Initialize, Background, Routes>,
  "rpc" | "mcp" | "ui" | "uiAssets"
> & Readonly<Partial<{ database: Readonly<{ filename: string }> }>>

class InfrastructureDatabaseConfigurationError extends Schema.TaggedError<InfrastructureDatabaseConfigurationError>()(
  "InfrastructureDatabaseConfigurationError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

type InfrastructureRunEffect<
  App extends ApplicationIR,
  Services extends RuntimeLayer,
  Initialize extends Initialization,
  Background extends RuntimeLayer,
  Routes extends RuntimeLayer,
> = Effect.Effect<
  void,
  | ApplicationInfrastructureError
  | InfrastructureDatabaseConfigurationError
  | RunErrors<App, Services, Initialize, Background, Routes>,
  RunRequirements<App, Services, Initialize, Background, Routes>
>

const runInfrastructureEffect = Effect.fn("ApplicationBun.runInfrastructure")(function* <
  App extends ApplicationIR,
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
  Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
>(
  infrastructure: ApplicationInfrastructureIR<App>,
  options: InfrastructureRunOptions<Services, Initialize, Background, Routes> = {},
) {
  const plan = yield* ApplicationInfrastructure.plan("ApplicationBun", infrastructure)
  const http = ApplicationInfrastructure.httpOptions(plan.runtime.resource)
  const configuredFilename = options.database?.filename
  const ephemeral = plan.database.resource.durability === "ephemeral"
  const invalidEphemeralFilename = ephemeral && configuredFilename !== undefined

  if (invalidEphemeralFilename) {
    return yield* InfrastructureDatabaseConfigurationError.make({
      reason: "An ephemeral infrastructure database cannot use a persistent filename",
    })
  }

  const defaultDatabase = ephemeral
    ? new InfrastructureFileDatabaseOptions({
      migrations: plan.database.resource.migrations,
      filename: ":memory:",
    })
    : new InfrastructureDatabaseOptions({ migrations: plan.database.resource.migrations })

  const database = configuredFilename === undefined
    ? defaultDatabase
    : new InfrastructureFileDatabaseOptions({
      migrations: plan.database.resource.migrations,
      filename: configuredFilename,
    })

  // SAFETY: Planning and run channels are derived from this infrastructure and these options.
  return yield* runApplication(plan.application, {
    ...options,
    ...http,
    database,
  }) as InfrastructureRunEffect<App, Services, Initialize, Background, Routes>
})

interface RunInfrastructure {
  <App extends ApplicationIR>(
    infrastructure: ApplicationInfrastructureIR<App>,
  ): InfrastructureRunEffect<
    App,
    Layer.Layer<never, never, never>,
    Effect.Effect<void>,
    Layer.Layer<never, never, never>,
    Layer.Layer<never, never, never>
  >

  <
    App extends ApplicationIR,
    Services extends RuntimeLayer = Layer.Layer<never, never, never>,
    Initialize extends Initialization = Effect.Effect<void>,
    Background extends RuntimeLayer = Layer.Layer<never, never, never>,
    Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
  >(
    infrastructure: ApplicationInfrastructureIR<App>,
    options: InfrastructureRunOptions<Services, Initialize, Background, Routes>,
  ): InfrastructureRunEffect<App, Services, Initialize, Background, Routes>
}

// SAFETY: The overloads expose the generic channels already preserved by runInfrastructureEffect.
export const runInfrastructure = runInfrastructureEffect as RunInfrastructure
