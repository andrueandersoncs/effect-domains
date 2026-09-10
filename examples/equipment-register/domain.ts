import { Schema } from "effect"

export const AssetTagSchema = Schema.String.check(Schema.isPattern(/^EQ-[A-Z0-9]{4,12}$/))
export const AssetConditionSchema = Schema.Literals(["in-service", "needs-repair", "retired"])

export const AssetSchema = Schema.Struct({
  assetTag: AssetTagSchema,
  name: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  serial: Schema.NullOr(Schema.NonEmptyString),
  location: Schema.NonEmptyString,
  condition: AssetConditionSchema,
})

