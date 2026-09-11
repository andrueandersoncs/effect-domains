import { Effect, Layer, Schema, pipe } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

export class ExampleWebAssetsError extends Schema.TaggedError<ExampleWebAssetsError>()("ExampleWebAssetsError", {
  reason: Schema.String,
}) {}

const escapeHtml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")

const readAsset = (file: URL) => Effect.tryPromise({
  try: () => Bun.file(file).text(),
  catch: (cause) => ExampleWebAssetsError.make({
    reason: `Could not read prebuilt frontend asset ${file.pathname}. Run \`bun run build\` before serving. ${String(cause)}`,
  }),
})

export const layerHttp = (options: Readonly<{
  title: string
  javascript: URL
  stylesheet: URL
  accent?: string
}>) => pipe(
  Effect.fn("ExampleWeb.register")(function* () {
    const javascript = yield* readAsset(options.javascript)
    const stylesheet = yield* readAsset(options.stylesheet)
    const router = yield* HttpRouter.HttpRouter
    const accent = options.accent ?? "#9a3412"
    const document = `<!doctype html>
<html lang="en" style="--accent:${accent}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(options.title)}</title><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script></head><body><div id="root"></div><noscript>This application requires JavaScript.</noscript></body></html>`

    const headers = { "cache-control": "no-store" }
    yield* router.add("GET", "/", HttpServerResponse.html(document))
    yield* router.add("GET", "/app.js", HttpServerResponse.text(javascript, { contentType: "text/javascript", headers }))
    yield* router.add("GET", "/app.css", HttpServerResponse.text(stylesheet, { contentType: "text/css", headers }))
  })(),
  Layer.effectDiscard,
) as Layer.Layer<never, ExampleWebAssetsError, HttpRouter.HttpRouter>

export const ExampleWeb = { layerHttp }
