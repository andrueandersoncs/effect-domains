import { Effect } from "effect"

const build = Effect.fn("Admin.build")(function* () {
  const result = yield* Effect.tryPromise({
    try: () => Bun.build({
      entrypoints: [
        Bun.fileURLToPath(new URL("./src/client.ts", import.meta.url)),
        Bun.fileURLToPath(new URL("./src/style.css", import.meta.url)),
      ],
      outdir: Bun.fileURLToPath(new URL("./dist", import.meta.url)),
      target: "browser",
      minify: true,
      naming: "[name].[ext]",
    }),
    catch: (cause) => new Error(`Could not build admin assets: ${String(cause)}`),
  })

  if (!result.success) {
    return yield* Effect.fail(new AggregateError(result.logs, "Could not build admin assets"))
  }
})

await Effect.runPromise(build())
