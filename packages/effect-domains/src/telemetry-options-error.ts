import { Schema } from "effect"

export class TelemetryOptionsError extends Schema.TaggedError<TelemetryOptionsError>()(
  "TelemetryOptionsError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

export const telemetryOptionsError = (error: Schema.SchemaError) => {
  const reason = String(error)

  return TelemetryOptionsError.make({ reason })
}
