import { Effect, Schema } from "effect"

class AdminBuildError extends Schema.TaggedError<AdminBuildError>()("AdminBuildError", {
  message: Schema.String,
}) {}

const build = Effect.fn("Admin.build")(function* () {
  const clientUrl = new URL("./src/client.ts", import.meta.url)
  const stylesheetUrl = new URL("./src/style.css", import.meta.url)
  const outputUrl = new URL("./dist", import.meta.url)
  const clientEntrypoint = Bun.fileURLToPath(clientUrl)
  const stylesheetEntrypoint = Bun.fileURLToPath(stylesheetUrl)
  const outputDirectory = Bun.fileURLToPath(outputUrl)

  const result = yield* Effect.tryPromise({
    try: () => Bun.build({
      entrypoints: [clientEntrypoint, stylesheetEntrypoint],
      outdir: outputDirectory,
      target: "browser",
      minify: true,
      naming: "[name].[ext]",
    }),

    catch: () => AdminBuildError.make({ message: "Could not build admin assets." }),
  })

  if (!result.success) {
    const error = AdminBuildError.make({ message: "Could not build admin assets." })
    return yield* Effect.fail(error)
  }
})

const program = build()

await Effect.runPromise(program)
