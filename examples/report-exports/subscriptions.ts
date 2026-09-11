import { Array, Clock, Effect, Equivalence, Layer, Option, Schema, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Authorization } from "effect-domains/authorization"
import { EntitlementUnavailable, Entitlements } from "effect-domains/entitlements"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { ExampleSubjectSchema } from "@effect-domains/example-support/subject"

const TenantIdSchema = pipe(Schema.NonEmptyString, identifier)
const SubscriptionStatusSchema = Schema.Literals(["active", "canceled"])

const ReportSubscriptionSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  status: SubscriptionStatusSchema,
  validUntilEpochSeconds: Schema.Int,
  graceUntilEpochSeconds: Schema.NullOr(Schema.Int),
})

const SubscriptionRowSchema = Schema.Struct({
  status: SubscriptionStatusSchema,
  validUntilEpochSeconds: Schema.Int,
  graceUntilEpochSeconds: Schema.NullOr(Schema.Int),
})

const SubscriptionRowsSchema = Schema.Array(SubscriptionRowSchema)

export const ReportSubscriptionsResource = Resource.make({
  authorization: Authorization.deny,
  name: "report_subscriptions",
  schema: ReportSubscriptionSchema,
  operations: {},
})

const unavailable = () => EntitlementUnavailable.make({})
const equals = Equivalence.strictEqual<string>()

const subscriptionAccess = (now: number) => (subscription: typeof SubscriptionRowSchema.Type) => {
  const paidTerm = now < subscription.validUntilEpochSeconds
  const canceled = equals(subscription.status, "canceled")
  const grace = pipe(Option.fromNullishOr(subscription.graceUntilEpochSeconds), Option.exists((until) => now < until))
  const cancellationGrace = canceled && grace
  return paidTerm || cancellationGrace
}

const entitlementService = Effect.gen(function* () {
  const database = yield* SqlClient.SqlClient

  const has = Effect.fn("ReportExports.Entitlements.has")(function* (request: Parameters<Entitlements["Service"]["has"]>[0]) {
    const subject = yield* pipe(Schema.decodeUnknownEffect(ExampleSubjectSchema)(request.subject), Effect.mapError(unavailable))
    const named = equals(request.name, "reports.generate")
    const account = equals(subject.tenantId, request.key)
    const supported = named && account
    if (!supported) return yield* Effect.succeed(false)

    const rows = yield* pipe(
      database`
        SELECT status, validUntilEpochSeconds, graceUntilEpochSeconds
        FROM ${database(ReportSubscriptionsResource.table.name)}
        WHERE tenantId = ${subject.tenantId}
        LIMIT 1
      `,
      Effect.flatMap(Schema.decodeUnknownEffect(SubscriptionRowsSchema)),
      Effect.mapError(unavailable),
    )

    const milliseconds = yield* Clock.currentTimeMillis
    const now = Math.floor(milliseconds / 1_000)
    return pipe(Array.head(rows), Option.exists(subscriptionAccess(now)))
  })

  return Entitlements.of({ has })
})

export const ReportExportEntitlements = Layer.effect(Entitlements, entitlementService)

// Seed once because restarting must not renew or restore a canceled subscription.
export const seedReportExportSubscriptions = Effect.fn("ReportExports.seedSubscriptions")(function* () {
  const database = yield* SqlClient.SqlClient
  const milliseconds = yield* Clock.currentTimeMillis
  const now = Math.floor(milliseconds / 1_000)
  const validUntilEpochSeconds = now + (30 * 24 * 60 * 60)

  yield* database`
    INSERT INTO ${database(ReportSubscriptionsResource.table.name)}
      (tenantId, status, validUntilEpochSeconds, graceUntilEpochSeconds)
    VALUES (${"acme"}, ${"active"}, ${validUntilEpochSeconds}, ${null})
    ON CONFLICT (tenantId) DO NOTHING
  `
})
