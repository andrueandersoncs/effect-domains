import { Schema, pipe } from "effect"
import { identifier } from "effect-domains/domain"

export const FieldReportIdSchema = pipe(
  Schema.String.check(Schema.isPattern(/^report_[a-z0-9]{8,32}$/)),
  Schema.brand("FieldReportId"),
  identifier,
)

export const FieldReportSchema = Schema.Struct({
  id: FieldReportIdSchema,
  title: Schema.NonEmptyString,
  site: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
})

