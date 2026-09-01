import { Schema } from "effect"
import { DomainIdentifier } from "./constants.ts"

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
 * import { identifier } from "effect-domains/domain/algorithms"
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
