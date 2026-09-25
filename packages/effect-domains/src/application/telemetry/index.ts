import { Effect } from "effect"

import { browserGateway } from "./browser.ts"
import { layer } from "./exporter.ts"
import { httpMiddleware } from "./observation.ts"

export const ApplicationTelemetry = {
  browserGateway: Effect.fn("ApplicationTelemetry.browserGateway")(browserGateway),
  httpMiddleware,
  layer,
}
