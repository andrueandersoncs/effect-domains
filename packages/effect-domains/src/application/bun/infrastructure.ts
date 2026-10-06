import { Data, Effect, Equivalence, Layer, Option, Schema } from "effect"
import type { ApplicationIR } from "../index.ts"
import { runApplication, type RunErrors, type RunRequirements } from "./runtime.ts"
import { ApplicationInfrastructure, type ApplicationInfrastructureError } from "../infrastructure.ts"
import type { ApplicationHttpOptions, ApplicationRuntimeOptions, Initialization, RuntimeLayer } from "../runtime.ts"
import type { ApplicationInfrastructureIR } from "../../infrastructure/compiler.ts"
import type { SqliteMigration } from "../../sqlite/migration-model.ts"

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
> = ApplicationRuntimeOptions<Services, Initialize, Background>
  & Pick<ApplicationHttpOptions<Services, Initialize, Background, Routes>, "routes" | "telemetry">
  & Readonly<Partial<{ database: Readonly<{ filename: string }> }>>

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

export const runInfrastructure = Effect.fn("ApplicationBun.runInfrastructure")(function* <
  App extends ApplicationIR,
  Services extends RuntimeLayer = Layer.Layer<never, never, never>,
  Initialize extends Initialization = Effect.Effect<void>,
  Background extends RuntimeLayer = Layer.Layer<never, never, never>,
  Routes extends RuntimeLayer = Layer.Layer<never, never, never>,
>(
  infrastructure: ApplicationInfrastructureIR<App>,
  options: InfrastructureRunOptions<Services, Initialize, Background, Routes>,
) {
  const plan = yield* ApplicationInfrastructure.plan("ApplicationBun", infrastructure)
  const http = ApplicationInfrastructure.httpOptions(plan.runtime.resource)
  const configuredFilename = Option.fromNullishOr(options.database?.filename)

  const ephemeral = Equivalence.strictEqual<typeof plan.database.resource.durability>()(
    plan.database.resource.durability,
    "ephemeral",
  )

  const invalidEphemeralFilename = ephemeral && Option.isSome(configuredFilename)

  if (invalidEphemeralFilename) {
    return yield* InfrastructureDatabaseConfigurationError.make({
      reason: "An ephemeral infrastructure database cannot use a persistent filename",
    })
  }

  const filename = ephemeral ? Option.some(":memory:") : configuredFilename

  const database = Option.match(filename, {
    onNone: () => new InfrastructureDatabaseOptions({ migrations: plan.database.resource.migrations }),
    onSome: (value) => new InfrastructureFileDatabaseOptions({
      migrations: plan.database.resource.migrations,
      filename: value,
    }),
  })

  // SAFETY: Channels match because this plan derives from the supplied infrastructure.
  return yield* runApplication<App, Services, Initialize, Background, Routes>(plan.application, {
    ...options,
    ...http,
    database,
  // SAFETY: Required layers remain present because all options are copied unchanged.
  } as Parameters<typeof runApplication<App, Services, Initialize, Background, Routes>>[1]) as InfrastructureRunEffect<App, Services, Initialize, Background, Routes>
})

