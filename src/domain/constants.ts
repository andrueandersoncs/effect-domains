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
 * import { DomainIdentifier } from "effect-domains/domain/constants"
 *
 * const value = DomainIdentifier
 * ```
 *
 */
export const DomainIdentifier = "@effect-domains/domain/identifier"
