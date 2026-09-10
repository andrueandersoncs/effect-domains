import { Effect, pipe } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { PrometheusMetrics } from "effect/unstable/observability"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"

const metrics = Effect.fn("DurableWorkflows.metrics")(function* (request: HttpServerRequest.HttpServerRequest) {
  const authenticator = yield* AuthorizationRpc.Authenticator

  const authenticated = yield* pipe(
    authenticator.authenticate(request.headers),
    Effect.as(true),
    Effect.catchTag("Unauthenticated", () => Effect.succeed(false)),
  )

  if (!authenticated) {
    return HttpServerResponse.empty({ status: 401 })
  }

  const body = yield* PrometheusMetrics.format({ prefix: "durable_workflows" })

  return HttpServerResponse.text(body, {
    contentType: "text/plain; version=0.0.4; charset=utf-8",
  })
})

export const DurableWorkflowRoutes = HttpRouter.add("GET", "/operator/metrics", metrics)
