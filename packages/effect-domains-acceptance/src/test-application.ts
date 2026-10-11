import { Effect, Schema } from "effect"
import { Application, Part } from "effect-domains/application"
import { Command } from "effect-domains/command"

class RatingUnavailable extends Schema.TaggedError<RatingUnavailable>()("RatingUnavailable", {}) {}

const RatingSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))

const NullableRatingSchema = Schema.NullOr(RatingSchema)

const RatePayloadSchema = Schema.Struct({
  rating: NullableRatingSchema,
  score: RatingSchema,
  note: Schema.String,
})

interface RatePayload extends Schema.Schema.Type<typeof RatePayloadSchema> {}

const rate = Command.family("ratings.", RatingUnavailable).define({ name: "rate", payload: RatePayloadSchema, success: NullableRatingSchema })

const rateHandler = Command.implement(rate, Effect.fn("TestApplication.rate")(function* (payload: RatePayload) {
  return yield* Effect.succeed(payload.rating)
}))

const RatingCommands = Command.bundle(rateHandler)

const parts = [Part.command(RatingCommands)]

const definition = Application.define({ name: "acceptance-test", parts })

const compiled = Application.compile(definition)

// The test application compiles synchronously because it is a pure definition without services.
const testApplication = Effect.runSync(compiled)

/** Observes a resource through its generated list operation, the convention every test catalog uses. */
const listOperation = (resource: string) => `${resource}.list`

export { testApplication as TestApplication, listOperation }
