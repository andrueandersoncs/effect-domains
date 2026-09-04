import { Schema } from "effect"

export const DomainIdentifier = "@effect-domains/domain/identifier"

export const identifier = <S extends Schema.ConstraintRebuildable>(
  schema: S,
) =>
  Schema.brand(DomainIdentifier)(schema).annotate({
    [DomainIdentifier]: true,
  })
