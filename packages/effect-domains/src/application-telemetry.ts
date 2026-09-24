import { Effect } from "effect"

import { browserGateway } from "./application-telemetry-browser.ts"
import { layer } from "./application-telemetry-exporter.ts"
import { httpMiddleware } from "./application-telemetry-observation.ts"

export const ApplicationTelemetry = {
  browserGateway: Effect.fn("ApplicationTelemetry.browserGateway")(browserGateway),
  httpMiddleware,
  layer,
}
