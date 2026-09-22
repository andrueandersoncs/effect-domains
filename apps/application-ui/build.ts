import { Effect, Schema } from "effect"

class ApplicationUiBuildError extends Schema.TaggedError<ApplicationUiBuildError>()("ApplicationUiBuildError", {
  message: Schema.String,
}) {}

const build = Effect.fn("ApplicationUi.build")(function* () {
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

    catch: () => ApplicationUiBuildError.make({ message: "Could not build application UI assets." }),
  })

  if (!result.success) {
    const error = ApplicationUiBuildError.make({ message: "Could not build application UI assets." })

    return yield* Effect.fail(error)
  }
})

const program = build()

await Effect.runPromise(program)
