import { Schema, pipe } from "effect"
import { identifier } from "effect-domains/domain"

const isGuideId = Schema.isPattern(/^guide-[a-z0-9-]{3,64}$/)

export const GuideIdSchema = pipe(
  Schema.String.check(isGuideId),
  Schema.brand("GuideId"),
)

export const GuideSchema = Schema.Struct({
  id: identifier(GuideIdSchema),
  tenantId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  summary: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
})

export const GuidePurchaseStatusSchema = Schema.Literals(["granted", "refunded", "revoked"])

export const GuidePurchaseSchema = Schema.Struct({
  id: pipe(Schema.NonEmptyString, identifier),
  tenantId: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
  guideId: GuideIdSchema,
  status: GuidePurchaseStatusSchema,
})
