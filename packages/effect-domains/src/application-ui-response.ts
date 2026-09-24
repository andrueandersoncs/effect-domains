import { Effect, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"

export const responseHeaders = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
})

const ErrorEnvelopeSchema = Schema.Struct({
  error: Schema.Struct({ message: Schema.String }),
})

interface ErrorEnvelope extends Schema.Schema.Type<typeof ErrorEnvelopeSchema> {}


const response = Effect.fn("ApplicationUi.response")(function* (
  status: number,
  body: Schema.Json,
) {
  return yield* HttpServerResponse.json(body, { status, headers: responseHeaders })
})

export const applicationUiSuccessResponse = Effect.fn("ApplicationUi.successResponse")(function* (
  body: Schema.Json,
) {
  return yield* response(200, body)
})

export const applicationUiDeclaredErrorResponse = Effect.fn("ApplicationUi.declaredErrorResponse")(function* (
  body: Schema.Json,
) {
  return yield* response(422, body)
})

export const applicationUiFailureResponse = Effect.fn("ApplicationUi.failure")(function* (
  status: 400 | 403 | 415,
  message: string,
) {
  const body = ErrorEnvelopeSchema.make({ error: { message } })

  return yield* response(status, body)
})

export const applicationUiInternalResponse = HttpServerResponse.text(
  '{"error":{"message":"Operation failed due to an internal server error."}}',
  { status: 500, contentType: "application/json", headers: responseHeaders },
)
