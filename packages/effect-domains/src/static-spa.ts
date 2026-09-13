import { Effect, Layer, Schema, pipe } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

class StaticSpaAssetsError extends Schema.TaggedError<StaticSpaAssetsError>()("StaticSpaAssetsError", {
  reason: Schema.String,
}) {}

const StaticSpaSiteSchema = Schema.Struct({
  title: Schema.String,
  base: Schema.instanceOf(URL),
  accent: Schema.NullOr(Schema.String),
})

const HeadersSchema = Schema.Record(Schema.String, Schema.String)

const escapeHtml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")

const readAsset = (file: URL) => Effect.tryPromise({
  try: () => Bun.file(file).text(),
  catch: (cause) => StaticSpaAssetsError.make({
    reason: `Could not read prebuilt frontend asset ${file.pathname}. Run \`bun run build\` before serving. ${String(cause)}`,
  }),
})

const site = (definition: typeof StaticSpaSiteSchema.Type) =>
  StaticSpaSiteSchema.make(definition)

const register = Effect.fn("StaticSpa.register")(function* (options: typeof StaticSpaSiteSchema.Type) {
  const javascriptUrl = new URL("./dist/entry.js", options.base)
  const stylesheetUrl = new URL("./dist/styles.css", options.base)
  const javascript = yield* readAsset(javascriptUrl)
  const stylesheet = yield* readAsset(stylesheetUrl)
  const router = yield* HttpRouter.HttpRouter
  const accent = options.accent ?? "#9a3412"

  const document = `<!doctype html>
<html lang="en" style="--accent:${accent}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(options.title)}</title><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script></head><body><div id="root"></div><noscript>This application requires JavaScript.</noscript></body></html>`

  const headers = HeadersSchema.make({ "cache-control": "no-store" })
  const htmlResponse = HttpServerResponse.html(document)
  const javascriptResponse = HttpServerResponse.text(javascript, { contentType: "text/javascript", headers })
  const stylesheetResponse = HttpServerResponse.text(stylesheet, { contentType: "text/css", headers })

  yield* router.add("GET", "/", htmlResponse)
  yield* router.add("GET", "/app.js", javascriptResponse)
  yield* router.add("GET", "/app.css", stylesheetResponse)
})

const layerHttp = (options: typeof StaticSpaSiteSchema.Type) => pipe(
  register(options),
  Layer.effectDiscard,
) as Layer.Layer<never, StaticSpaAssetsError, HttpRouter.HttpRouter>

export const StaticSpa = { site, layerHttp }
