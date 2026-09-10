import { Effect, flow, pipe } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { PrometheusMetrics } from "effect/unstable/observability"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { Authorization, AuthorizationSubject } from "effect-domains/authorization"
import { ReportExportOperatorAuthorization } from "./authorization.ts"

const metrics = Effect.fn("ReportExports.metrics")(function* (request: HttpServerRequest.HttpServerRequest) {
  const authenticator = yield* AuthorizationRpc.Authenticator
  const subject = yield* authenticator.authenticate(request.headers)
  yield* pipe(Authorization.requireSubject(ReportExportOperatorAuthorization), Effect.provideService(AuthorizationSubject, subject))

  const body = yield* PrometheusMetrics.format({ prefix: "report_exports" })

  return HttpServerResponse.text(body, {
    contentType: "text/plain; version=0.0.4; charset=utf-8",
  })
})

const metricsHandler = flow(metrics, Effect.catchTags({
  Unauthenticated: () => Effect.sync(() => HttpServerResponse.empty({ status: 401 })),
  Forbidden: () => Effect.sync(() => HttpServerResponse.empty({ status: 403 })),
}))

export const ReportExportRoutes = HttpRouter.add("GET", "/operator/metrics", metricsHandler)
