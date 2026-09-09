import { Effect, Layer, Option, Record, Schema, pipe } from "effect"
import { Unauthenticated } from "effect-domains/authorization"
import { Authenticator } from "effect-domains/authorization-rpc"
import { Headers } from "effect/unstable/http"

export const ExampleSubjectSchema = Schema.Struct({ userId: Schema.String, tenantId: Schema.String, roles: Schema.Array(Schema.String) })
interface ExampleSubject extends Schema.Schema.Type<typeof ExampleSubjectSchema> {}

// These credentials are public because the examples demonstrate policy, not production identity issuance.
const alice = ExampleSubjectSchema.make({ userId: "alice", tenantId: "acme", roles: ["editor"] })
const bob = ExampleSubjectSchema.make({ userId: "bob", tenantId: "acme", roles: ["reader"] })
const administrator = ExampleSubjectSchema.make({ userId: "admin", tenantId: "acme", roles: ["admin"] })
const outsider = ExampleSubjectSchema.make({ userId: "alice", tenantId: "other", roles: ["editor"] })

const sessions = Record.fromEntries([
  ["Bearer alice-demo", alice],
  ["Bearer bob-demo", bob],
  ["Bearer admin-demo", administrator],
  ["Bearer outsider-demo", outsider],
])

const sessionFor = (token: string) => Record.get(sessions, token)

const authenticate = Effect.fn("ExampleAuthentication.authenticate")(function* (headers: Headers.Headers) {
  const subject = pipe(Headers.get(headers, "authorization"), Option.flatMap(sessionFor))
  return yield* Effect.fromOption(subject, () => Unauthenticated.make({}))
})

const authenticator = Authenticator.of({ authenticate })
export const ExampleAuthentication = Layer.succeed(Authenticator, authenticator)
