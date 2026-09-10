import { Context, Effect, Equivalence, Option, Schema } from "effect"

export class EntitlementRequired extends Schema.TaggedError<EntitlementRequired>()("EntitlementRequired", { entitlement: Schema.String }) {}
export class EntitlementUnavailable extends Schema.TaggedError<EntitlementUnavailable>()("EntitlementUnavailable", {}) {}
const granted = Equivalence.strictEqual<boolean>()

export class Entitlements extends Context.Service<Entitlements, {
  readonly has: (request: Readonly<{
    name: string
    key: string
    subject: Readonly<Record<string, unknown>>
  }>) => Effect.Effect<boolean, EntitlementUnavailable>
}>()("@effect-domains/Entitlements") {
  static readonly require = Effect.fn("Entitlements.require")(function* (request: Parameters<Entitlements["Service"]["has"]>[0]) {
    const service = yield* Effect.serviceOption(Entitlements)
    if (Option.isNone(service)) return yield* EntitlementUnavailable.make({})
    const allowed = yield* service.value.has(request)
    if (!granted(allowed, true)) return yield* EntitlementRequired.make({ entitlement: request.name })
  })
}
