import { BunRuntime } from "@effect/platform-bun"
import { Array, Console, Effect, Order, pipe } from "effect"

const maximumLines = 500
const packageRoot = new URL("..", import.meta.url).pathname

const countLines = (source: string) => {
  if (source.length === 0) return 0

  const lineBreaks = source.match(/\n/g)?.length ?? 0

  return source.endsWith("\n") ? lineBreaks : lineBreaks + 1
}

const checkFile = Effect.fn("FileLines.checkFile")(function* (path: string) {
  const source = yield* Effect.tryPromise(() => Bun.file(`${packageRoot}/${path}`).text())

  return { path, lines: countLines(source) }
})

const program = Effect.gen(function* () {
  const paths = yield* Effect.tryPromise(() => globalThis.Array.fromAsync(
    new Bun.Glob("src/**/*.ts").scan({ cwd: packageRoot, onlyFiles: true }),
  ))

  const files = yield* Effect.forEach(paths, checkFile, { concurrency: "unbounded" })
  const violations = pipe(
    files,
    Array.filter(({ lines }) => lines > maximumLines),
    Array.sort(Order.mapInput(Order.String, (entry: { readonly lines: number; readonly path: string }) => entry.path)),
  )

  if (violations.length > 0) {
    const details = pipe(
      violations,
      Array.map(({ lines, path }) => `  ${path}: ${lines} lines`),
      Array.join("\n"),
    )

    return yield* Effect.fail(new Error(`Source files may not exceed ${maximumLines} lines:\n${details}`))
  }

  yield* Console.log(`Checked ${files.length} source files; all are at most ${maximumLines} lines.`)
})

BunRuntime.runMain(program)
