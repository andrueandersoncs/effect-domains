import { Schema } from "effect"

/**

Use when: inspecting schema annotations because this key marks intrinsic
domain identity.

Example: read `DomainIdentifier` from resolved schema annotations.

**/
export const DomainIdentifier = "@effect-domains/domain/identifier"

/**

Use when: defining canonical schemas because domain identity must stay
independent of persistence.

Example: `Domain.identifier(Schema.String)` marks an identifier field.

**/
export abstract class Domain {
  static identifier<S extends Schema.ConstraintRebuildable>(
    schema: S,
  ): Schema.brand<S["Rebuild"], typeof DomainIdentifier> {
    return Schema.brand(DomainIdentifier)(schema).annotate({
      [DomainIdentifier]: true,
    })
  }
}
