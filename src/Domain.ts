import { Schema } from "effect"

export const DomainIdentifier = "@effect-domains/domain/identifier"

/** Annotates intrinsic entity identity for schema interpreters. */
export abstract class Domain {
  static identifier<S extends Schema.ConstraintRebuildable>(
    schema: S,
  ): Schema.brand<S["Rebuild"], typeof DomainIdentifier> {
    return Schema.brand(DomainIdentifier)(schema).annotate({
      [DomainIdentifier]: true,
    })
  }
}
