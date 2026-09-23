import { Effect, Layer, Option, Struct, pipe } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { type Rpc, type RpcGroup } from "effect/unstable/rpc"
import type { ApplicationUiPresentation } from "@effect-domains/application-ui/contract"
import type { ApplicationIR } from "./application.ts"
import { compileApplicationCall, ApplicationUiDefinitionError } from "./application-ui-rpc.ts"

import {
  applicationUiInternalResponse,
  responseHeaders,
} from "./application-ui-response.ts"

import { applicationUiPaths } from "./application-ui-paths.ts"
import { ApplicationInspect } from "./application-inspect.ts"
import { ApplicationTelemetry, type TelemetryOptions } from "./application-telemetry.ts"

export type ApplicationUiOptions = Readonly<Partial<{
  path: string
  presentation: ApplicationUiPresentation
  allowedOrigins: ReadonlyArray<string>
}>>

type ApplicationUiLayerOptions<App extends ApplicationIR = ApplicationIR> = Readonly<{
  application: App
  javascript: string
  stylesheet: string
}> & Readonly<Partial<{ telemetry: TelemetryOptions }>> & ApplicationUiOptions

const maximumAssetCodeUnits = 2_000_000

const maximumBrowserTelemetryText = 2_048

const validateAssets = Effect.fn("ApplicationUi.validateAssets")(function* (
  options: Pick<ApplicationUiLayerOptions, "javascript" | "stylesheet">,
) {
  const javascriptTooLarge = options.javascript.length > maximumAssetCodeUnits
  const stylesheetTooLarge = options.stylesheet.length > maximumAssetCodeUnits
  const assetsTooLarge = javascriptTooLarge || stylesheetTooLarge

  if (assetsTooLarge) {
    return yield* ApplicationUiDefinitionError.make({
      reason: `Application UI assets must each contain at most ${maximumAssetCodeUnits} code units`,
    })
  }
})

const uiPath = Effect.fn("ApplicationUi.path")(function* (path: string) {
  if (!/^\/$|^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path)) {
    return yield* ApplicationUiDefinitionError.make({
      reason: "Application UI path must be root or contain nonempty URL path segments without a trailing slash",
    })
  }

  // SAFETY: The validation proves the path type because only slash-prefixed forms are accepted.
  return path as `/${string}`
})

const escapeAttribute = (value: string) => {
  const ampersands = value.replaceAll("&", "&amp;")
  const quotes = ampersands.replaceAll('"', "&quot;")
  const lessThan = quotes.replaceAll("<", "&lt;")

  return lessThan.replaceAll(">", "&gt;")
}

const validateBrowserTelemetry = Effect.fn("ApplicationUi.validateBrowserTelemetry")(function* (
  browserTelemetry: Effect.Success<ReturnType<typeof ApplicationTelemetry.browserGateway>>,
) {
  if (Option.isNone(browserTelemetry)) return

  const endpointTooLong = browserTelemetry.value.endpoint.length > maximumBrowserTelemetryText
  const serviceNameTooLong = browserTelemetry.value.serviceName.length > maximumBrowserTelemetryText
  const telemetryTextTooLong = endpointTooLong || serviceNameTooLong

  if (telemetryTextTooLong) {
    return yield* ApplicationUiDefinitionError.make({
      reason: `Browser telemetry endpoint and service name must each contain at most ${maximumBrowserTelemetryText} code units`,
    })
  }
})

const telemetryAttribute = (
  browserTelemetry: Effect.Success<ReturnType<typeof ApplicationTelemetry.browserGateway>>,
) => {
  if (Option.isNone(browserTelemetry)) return ""

  const encoded = JSON.stringify(browserTelemetry.value)
  const escaped = escapeAttribute(encoded)

  return ` data-telemetry="${escaped}"`
}

const applicationDocument = (
  path: `/${string}`,
  clientPath: `/${string}`,
  stylesheetPath: `/${string}`,
  telemetry: string,
) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Effect Domains Application</title><link rel="stylesheet" href="${stylesheetPath}"><script type="module" src="${clientPath}"></script></head><body><div id="app" data-base="${path}"${telemetry}></div><noscript>This application requires JavaScript.</noscript></body></html>`

const uiResponses = Effect.fn("ApplicationUi.responses")(function* (
  options: ApplicationUiLayerOptions,
  path: `/${string}`,
  telemetry: string,
) {
  const inspection = yield* pipe(
    ApplicationInspect.describe(options.application),
    Effect.mapError((error) => ApplicationUiDefinitionError.make({ reason: error.message })),
  )
  const presentation = options.presentation ?? {}
  const metadata = Struct.assign(inspection, { presentation })
  const paths = applicationUiPaths(path)

  const document = applicationDocument(
    path,
    paths.javascript,
    paths.stylesheet,
    telemetry,
  )

  const documentResponse = HttpServerResponse.html(document)
  const html = HttpServerResponse.setHeaders(documentResponse, responseHeaders)

  const javascript = HttpServerResponse.text(options.javascript, {
    contentType: "text/javascript",
    headers: responseHeaders,
  })


  const stylesheet = HttpServerResponse.text(options.stylesheet, {
    contentType: "text/css",
    headers: responseHeaders,
  })


  return { paths, html, javascript, stylesheet, metadata }
})

const register = Effect.fn("ApplicationUi.register")(function* (
  options: ApplicationUiLayerOptions,
) {
  const path = yield* uiPath(options.path ?? "/")

  yield* validateAssets(options)

  const router = yield* HttpRouter.HttpRouter
  const allowedOrigins = Option.fromNullishOr(options.allowedOrigins)
  const receive = yield* compileApplicationCall(options.application, allowedOrigins)

  const browserTelemetry = yield* ApplicationTelemetry.browserGateway({
    application: options.application,
    telemetry: options.telemetry,
    allowedOrigins: options.allowedOrigins,
  })

  yield* validateBrowserTelemetry(browserTelemetry)

  const browserTelemetryAttribute = telemetryAttribute(browserTelemetry)
  const responses = yield* uiResponses(options, path, browserTelemetryAttribute)
  const internalMetadataFailure = () => Effect.succeed(applicationUiInternalResponse)
  const encodedMetadata = HttpServerResponse.json(responses.metadata, { headers: responseHeaders })

  const metadataResponse = Effect.catchTag(
    encodedMetadata,
    "HttpBodyError",
    internalMetadataFailure,
  )

  yield* router.add("GET", path, responses.html)
  yield* router.add("GET", responses.paths.javascript, responses.javascript)
  yield* router.add("GET", responses.paths.stylesheet, responses.stylesheet)
  yield* router.add("GET", responses.paths.api, metadataResponse)
  yield* router.add("POST", responses.paths.call, receive)
})

const layerHttp = <App extends ApplicationIR>(
  options: ApplicationUiLayerOptions<App>,
) => pipe(
  register(options),
  Layer.effectDiscard,
) as Layer.Layer<
  never,
  ApplicationUiDefinitionError,
  | HttpRouter.HttpRouter
  | Rpc.ToHandler<RpcGroup.Rpcs<App["group"]>>
  | Rpc.Middleware<RpcGroup.Rpcs<App["group"]>>
  | Rpc.MiddlewareClient<RpcGroup.Rpcs<App["group"]>>
  | Rpc.ServicesServer<RpcGroup.Rpcs<App["group"]>>
>

export const ApplicationUi = { layerHttp }
