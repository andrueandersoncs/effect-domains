import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

class IntakeAssetsError extends Schema.TaggedError<IntakeAssetsError>()("IntakeAssetsError", {
  message: Schema.String,
}) {}

const document = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open a case · Support cases</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/intake/style.css">
  <script type="module" src="/intake/client.js"></script>
</head>
<body>
  <header class="admin-header"><div class="admin-identity"><h1>Support cases</h1><p class="admin-subtitle">Guided case intake</p></div><a href="/">All operations</a></header>
  <main class="intake-shell"><div class="intake-intro"><h1>Open a support case</h1><p>Find the customer, describe the issue, then submit one case. Nothing is saved until submission.</p></div><div id="intake" aria-live="polite"></div></main>
  <noscript>This interaction requires JavaScript. Use the Open case operation on <a href="/">the application UI</a> instead.</noscript>
</body>
</html>`

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
}

const register = Effect.gen(function* () {
  const entrypoint = Bun.fileURLToPath(new URL("./intake-client.ts", import.meta.url))
  const stylesheet = Bun.file(new URL("./intake.css", import.meta.url))
  const failure = () => IntakeAssetsError.make({ message: "Could not load the case intake assets." })
  const result = yield* Effect.tryPromise({
    try: () => Bun.build({ entrypoints: [entrypoint], target: "browser", minify: true }),
    catch: failure,
  })
  const output = result.outputs[0]

  if (!result.success || !output) return yield* Effect.fail(failure())

  const javascript = yield* Effect.tryPromise({ try: () => output.text(), catch: failure })
  const css = yield* Effect.tryPromise({ try: () => stylesheet.text(), catch: failure })
  const router = yield* HttpRouter.HttpRouter

  const html = HttpServerResponse.setHeaders(HttpServerResponse.html(document), headers)

  yield* router.add("GET", "/intake", html)
  yield* router.add("GET", "/intake/client.js", HttpServerResponse.text(javascript, { contentType: "text/javascript", headers }))
  yield* router.add("GET", "/intake/style.css", HttpServerResponse.text(css, { contentType: "text/css", headers }))
})

export const IntakeRoutes = Layer.effectDiscard(register)
