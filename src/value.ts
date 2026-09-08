import { Context, DateTime, Effect } from "effect"

/** Runtime values used by generated resource creation policies. */
export class Value extends Context.Service<Value, {
  readonly uuidV7: () => Effect.Effect<string>
  readonly now: () => Effect.Effect<DateTime.Utc>
}>()("@effect-domains/Value") {}
