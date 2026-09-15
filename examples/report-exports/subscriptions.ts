import { DateTime, Effect, Schema, pipe } from "effect"

import { Authorization } from "effect-domains/authorization"
import { identifier } from "effect-domains/domain"


import { Entitlements } from "effect-domains/entitlements"

import { Resource } from "effect-domains/resource"

import { ExampleSubjectSchema } from "@effect-domains/example-support/subject"

const TenantIdSchema = pipe(Schema.NonEmptyString, identifier)
const SubscriptionStatusSchema = Schema.Literals(["active", "canceled"])

const ReportSubscriptionSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  status: SubscriptionStatusSchema,
  validUntil: Schema.DateTimeUtc,
  graceUntil: Schema.NullOr(Schema.DateTimeUtc),
})

export const ReportSubscriptionsResource = Resource.define({
  authorization: Authorization.public,
  name: "report_subscriptions",
  schema: ReportSubscriptionSchema,
  capabilities: [],
})



const reportSubscriptionsTable = Resource.table(ReportSubscriptionsResource)
const grants = Entitlements.for(reportSubscriptionsTable)
const currentlyValid = grants.lt(grants.now, grants.row.validUntil)
const canceled = grants.eq(grants.row.status, "canceled")
const withinGrace = grants.lt(grants.now, grants.row.graceUntil)
const canceledWithinGrace = grants.all(canceled, withinGrace)
const subscriptionAccess = grants.any(currentlyValid, canceledWithinGrace)

const entitlementDefinition = new Entitlements.Source({
  name: "reports.generate",
  table: reportSubscriptionsTable,
  subject: ExampleSubjectSchema,
  key: "tenantId",
  scope: { tenantId: "tenantId" },
  grant: subscriptionAccess,
})

export const ReportExportEntitlements = Entitlements.fromTable(
  entitlementDefinition,
)

// Seed once because restarting must not renew or restore a canceled subscription.
export const seedReportExportSubscriptions = Effect.fn(
  "ReportExports.seedSubscriptions",
)(function* () {
  const now = yield* DateTime.now
  const tenantId = TenantIdSchema.make("acme")
  const validUntil = DateTime.addDuration(now, "30 days")

  yield* Resource.repository(ReportSubscriptionsResource).ensure({
    tenantId,
    status: "active",
    validUntil,
    graceUntil: null,
  })
})
