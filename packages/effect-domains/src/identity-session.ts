import { Clock, DateTime, Effect, Equivalence, Predicate, Redacted, Schema, Struct, pipe } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { CredentialsSchema, IssuedSessionSchema } from "./identity.ts"
import { IdentityRpcs } from "./identity-rpc.ts"
import { Requests, RequestStateSchema, RequestTokenSchema } from "./requests.ts"
import { RpcBrowser } from "./rpc-browser.ts"
import { RpcService, type Type } from "./rpc-service.ts"

const Client = RpcService.make({ name: "effect-domains/IdentitySessionClient", group: IdentityRpcs })

const IdentitySessionModelSchema = Schema.Struct({
  username: Schema.String,
  password: Schema.String,
  token: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  requests: RequestStateSchema,
})

interface IdentitySessionModel extends Schema.Schema.Type<typeof IdentitySessionModelSchema> {}

const IssuedSessionTypeSchema = Schema.toType(IssuedSessionSchema)

const IdentitySessionMessageSchema = defineMessageUnion({
  ChangedUsername: { value: Schema.String },
  ChangedPassword: { value: Schema.String },
  ClickedLogin: {},
  ClickedLogout: {},
  SucceededLogin: { request: RequestTokenSchema, session: IssuedSessionTypeSchema },
  SucceededLogout: { request: RequestTokenSchema },
  Failed: { request: RequestTokenSchema, error: Schema.String },
  Expired: { generation: Schema.Int },
})

type IdentitySessionMessage = typeof IdentitySessionMessageSchema.Type
type UpdateReturn = Update.Return<IdentitySessionModel, IdentitySessionMessage, Type<typeof Client>>

const RedactedStringSchema = Schema.Redacted(Schema.String)
const CredentialsJsonSchema = Schema.toCodecJson(CredentialsSchema)

const CredentialsInputSchema = Schema.Struct({
  username: Schema.String,
  password: Schema.String,
})

const UpdateResultSchema = Schema.Struct({
  model: IdentitySessionModelSchema,
  commands: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})

const loginFailureMessage = (error: unknown) => {
  const hasTag = Predicate.hasProperty(error, "_tag")
  const tag = hasTag && Predicate.isString(error._tag) ? error._tag : ""
  const unauthenticated = Equivalence.strictEqual<string>()(tag, "Unauthenticated")

  if (unauthenticated) return "Invalid username or password."

  const invalidSchema = Equivalence.strictEqual<string>()(tag, "SchemaError")
  return invalidSchema ? "Enter a valid username and password." : RpcBrowser.messageFromUnknown(error)
}

class LoginArgs extends Schema.Class<LoginArgs>("IdentitySessionLoginArgs")({
  request: RequestTokenSchema,
  username: Schema.String,
  password: RedactedStringSchema,
}) {}

const loginWithCredentials = (credentials: typeof CredentialsSchema.Type) => pipe(
  Client,
  Effect.flatMap((client) => client["identity.login"](credentials)),
)

const executeLogin = Effect.fn("IdentitySession.executeLogin")(function* ({ request, username, password }: LoginArgs) {
  const normalizedUsername = username.trim()
  const normalizedPassword = Redacted.value(password)

  const input = CredentialsInputSchema.make({
    username: normalizedUsername,
    password: normalizedPassword,
  })

  const attempt = pipe(
    Schema.decodeUnknownEffect(CredentialsJsonSchema)(input),
    Effect.flatMap(loginWithCredentials),
  )

  return yield* pipe(attempt, Effect.match({
    onSuccess: (session) => IdentitySessionMessageSchema.SucceededLogin({ request, session }),
    onFailure: (error) => {
      const message = loginFailureMessage(error)
      return IdentitySessionMessageSchema.Failed({ request, error: message })
    },
  }))
})

const LoginConfig = Object.freeze({
  args: LoginArgs.fields,
  messages: [IdentitySessionMessageSchema.SucceededLogin, IdentitySessionMessageSchema.Failed],
  execute: executeLogin,
})

const Login = Command.define("IdentitySession.login", LoginConfig)

class LogoutArgs extends Schema.Class<LogoutArgs>("IdentitySessionLogoutArgs")({
  request: RequestTokenSchema,
  token: RedactedStringSchema,
}) {}

const executeLogout = Effect.fn("IdentitySession.executeLogout")(function* ({ request, token }: LogoutArgs) {
  const tokenValue = Redacted.value(token)
  const options = RpcBrowser.requestOptions(tokenValue)

  const attempt = pipe(
    Client,
    Effect.flatMap((client) => client["identity.logout"](undefined, options)),
    Effect.catchTag("Unauthenticated", () => Effect.void),
  )

  return yield* pipe(attempt, Effect.match({
    onSuccess: () => IdentitySessionMessageSchema.SucceededLogout({ request }),
    onFailure: (error) => {
      const message = RpcBrowser.messageFromUnknown(error)
      return IdentitySessionMessageSchema.Failed({ request, error: message })
    },
  }))
})

const LogoutConfig = Object.freeze({
  args: LogoutArgs.fields,
  messages: [IdentitySessionMessageSchema.SucceededLogout, IdentitySessionMessageSchema.Failed],
  execute: executeLogout,
})

const Logout = Command.define("IdentitySession.logout", LogoutConfig)

class ExpireArgs extends Schema.Class<ExpireArgs>("IdentitySessionExpireArgs")({
  generation: Schema.Int,
  expiresAt: Schema.DateTimeUtc,
}) {}

const executeExpire = Effect.fn("IdentitySession.executeExpire")(function* ({ generation, expiresAt }: ExpireArgs) {
  const now = yield* Clock.currentTimeMillis
  const expiry = DateTime.toEpochMillis(expiresAt)
  const duration = Math.max(0, expiry - now)
  yield* Effect.sleep(duration)

  return IdentitySessionMessageSchema.Expired({ generation })
})

const ExpireConfig = Object.freeze({
  args: ExpireArgs.fields,
  messages: [IdentitySessionMessageSchema.Expired],
  execute: executeExpire,
})

const Expire = Command.define("IdentitySession.expire", ExpireConfig)

const empty = () => IdentitySessionModelSchema.make({
  username: "",
  password: "",
  token: null,
  expiresAt: null,
  generation: 0,
  requests: Requests.empty(),
})

const clear = (model: IdentitySessionModel) => IdentitySessionModelSchema.make({
  ...model,
  password: "",
  token: null,
  expiresAt: null,
  generation: model.generation + 1,
  requests: Requests.reset(model.requests),
})

const result = (model: IdentitySessionModel) =>
  UpdateResultSchema.make({ model }) as UpdateReturn

const commanded = (
  model: IdentitySessionModel,
  commands: NonNullable<UpdateReturn["commands"]>,
) => UpdateResultSchema.make({ model, commands }) as UpdateReturn

const update = (model: IdentitySessionModel, message: IdentitySessionMessage) =>
  IdentitySessionMessageSchema.match<UpdateReturn>(message, {
    ChangedUsername: ({ value }) => {
      const pending = Requests.pending(model.requests)

      const next = pending
        ? model
        : IdentitySessionModelSchema.make({ ...model, username: value })

      return result(next)
    },
    ChangedPassword: ({ value }) => {
      const pending = Requests.pending(model.requests)

      const next = pending
        ? model
        : IdentitySessionModelSchema.make({ ...model, password: value })

      return result(next)
    },
    ClickedLogin: () => {
      const hasToken = Predicate.isNotNull(model.token)
      const pending = Requests.pending(model.requests)
      const blocked = hasToken || pending
      if (blocked) return result(model)

      const started = Requests.start(model.requests, "identity.session")
      const password = Redacted.make(model.password)
      const command = Login({ request: started.request, username: model.username, password })
      const next = IdentitySessionModelSchema.make({ ...model, password: "", requests: started.state })

      return commanded(next, [command])
    },
    ClickedLogout: () => {
      const missingToken = Predicate.isNull(model.token)
      const pending = Requests.pending(model.requests)
      const blocked = missingToken || pending
      if (blocked) return result(model)

      const started = Requests.start(model.requests, "identity.session")
      const token = Redacted.make(model.token)
      const command = Logout({ request: started.request, token })
      const next = IdentitySessionModelSchema.make({ ...model, requests: started.state })

      return commanded(next, [command])
    },
    SucceededLogin: ({ request, session }) => {
      if (!Requests.accepts(model.requests, request)) return result(model)

      const generation = model.generation + 1
      const token = Redacted.value(session.token)
      const expiresAt = DateTime.formatIso(session.expiresAt)
      const requests = Requests.succeed(model.requests, request)

      const next = IdentitySessionModelSchema.make({
        ...model,
        password: "",
        token,
        expiresAt,
        generation,
        requests,
      })

      const command = Expire({ generation, expiresAt: session.expiresAt })
      return commanded(next, [command])
    },
    SucceededLogout: ({ request }) => {
      const accepted = Requests.accepts(model.requests, request)
      const next = accepted ? clear(model) : model
      return result(next)
    },
    Failed: ({ request, error }) => {
      const accepted = Requests.accepts(model.requests, request)
      if (!accepted) return result(model)

      const requests = Requests.fail(model.requests, request, error)
      const next = IdentitySessionModelSchema.make({ ...model, password: "", requests })
      return result(next)
    },
    Expired: ({ generation }) => {
      const current = Equivalence.strictEqual<number>()(model.generation, generation)
      const next = current ? clear(model) : model
      return result(next)
    },
  })

export const IdentitySession = {
  Client,
  ModelSchema: IdentitySessionModelSchema,
  MessageSchema: IdentitySessionMessageSchema,
  empty,
  update,
  token: Struct.get<IdentitySessionModel, "token">("token"),
  expiresAt: Struct.get<IdentitySessionModel, "expiresAt">("expiresAt"),
  generation: Struct.get<IdentitySessionModel, "generation">("generation"),
}
