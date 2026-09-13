import { Effect, Equivalence, Schema } from "effect"

class ExampleWebBuildError extends Schema.TaggedError<ExampleWebBuildError>()("ExampleWebBuildError", {
  message: Schema.String,
}) {}

export const exampleWebApps = [
  "appointment-reminders",
  "editorial-calendar",
  "equipment-register",
  "expense-ledger",
  "field-notes",
  "orders-invoices",
  "purchased-guides",
  "repair-workshop",
  "reading-list",
  "report-exports",
  "reservations",
  "support-cases",
  "team-tasks",
] as const

const sameBoolean = Equivalence.strictEqual<boolean>()

const stylesheetUrl = new URL("./src/styles.css", import.meta.url)
const stylesheet = Bun.fileURLToPath(stylesheetUrl)

const buildApp = Effect.fn("ExampleWeb.buildApp")(function* (name: string) {
  const entryUrl = new URL(`../../examples/${name}/web/entry.ts`, import.meta.url)
  const outputUrl = new URL(`../../examples/${name}/web/dist`, import.meta.url)
  const entryPath = Bun.fileURLToPath(entryUrl)
  const outputDirectory = Bun.fileURLToPath(outputUrl)
  const present = yield* Effect.promise(() => Bun.file(entryPath).exists())

  if (sameBoolean(present, false)) {
    return yield* ExampleWebBuildError.make({ message: `Missing Foldkit entry ${entryPath}` })
  }

  const result = yield* Effect.tryPromise({
    try: () => Bun.build({
      entrypoints: [entryPath, stylesheet],
      outdir: outputDirectory,
      target: "browser",
      minify: true,
      naming: "[name].[ext]",
    }),
    catch: () => ExampleWebBuildError.make({ message: `Could not build ${name} frontend.` }),
  })

  if (sameBoolean(result.success, false)) {
    return yield* ExampleWebBuildError.make({ message: `Could not build ${name} frontend.` })
  }
})

const program = Effect.forEach(exampleWebApps, buildApp, { concurrency: 1 })

await Effect.runPromise(program)
