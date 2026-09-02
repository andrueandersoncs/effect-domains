import { Schema } from "effect"

/**
 *
 * Scope: public
 *
 * When to use: Schema tooling needs to inspect the annotation that marks
 * canonical domain identity because adapters must distinguish it from generated
 * identity.
 *
 * Example:
 * ```ts
 * import { DomainIdentifier } from "effect-domains/domain"
 *
 * const value = DomainIdentifier
 * ```
 *
 */
export const DomainIdentifier = "@effect-domains/domain/identifier"

/**
 *
 * Scope: public
 *
 * When to use: A canonical schema field needs intrinsic identity because
 * persistence must not define domain meaning.
 *
 * Example:
 * ```ts
 * import { Schema } from "effect"
 * import { identifier } from "effect-domains/domain"
 *
 * const UserId = identifier(Schema.String)
 * ```
 *
 */
export const identifier = <S extends Schema.ConstraintRebuildable>(
  schema: S,
) =>
  Schema.brand(DomainIdentifier)(schema).annotate({
    [DomainIdentifier]: true,
  })
