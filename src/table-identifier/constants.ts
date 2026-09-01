import { Schema } from "effect"

/**
 *
 * Scope: public
 *
 * When to use: Generated identity validation needs a UUIDv7 check because
 * persistence owns the default identifier value.
 *
 * Example:
 * ```ts
 * import { uuidV7Check } from "effect-domains/table-identifier/constants"
 *
 * const value = uuidV7Check
 * ```
 *
 */
export const uuidV7Check = Schema.isUUID(7)
