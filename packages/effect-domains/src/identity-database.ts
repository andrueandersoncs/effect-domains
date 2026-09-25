import { Effect, Schema, pipe } from "effect"
import { IdentityUnavailable } from "./identity.ts"

export const AccountUsernameRowSchema = Schema.Struct({ username: Schema.String })

export interface AccountUsernameRow extends Schema.Schema.Type<typeof AccountUsernameRowSchema> {}

export const unavailable = () => IdentityUnavailable.make({})

export const database = Effect.fn("SqliteIdentity.database")(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  return yield* pipe(effect, Effect.mapError(unavailable))
})
