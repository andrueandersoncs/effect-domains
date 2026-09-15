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
const sameGeneration = Equivalence.strictEqual<number>()

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
  username: Schema.String,
  password: RedactedStringSchema,
}) {}

const loginWithCredentials = (credentials: typeof CredentialsSchema.Type) => pipe(
  Client,
  Effect.flatMap((client) => client["identity.login"](credentials)),
)

const executeLogin = Effect.fn("IdentitySession.executeLogin")(function* ({ username, password }: LoginArgs) {
  const normalizedUsername = username.trim()
  const normalizedPassword = Redacted.value(password)

  const input = CredentialsInputSchema.make({
    username: normalizedUsername,
    password: normalizedPassword,
  })

  const session = yield* pipe(
    Schema.decodeUnknownEffect(CredentialsJsonSchema)(input),
    Effect.flatMap(loginWithCredentials),
  )

  return { session }
})

const Login = RpcBrowser.command("IdentitySession.login", {
  request: { key: "identity.session", concurrency: "exhaust" },
  args: LoginArgs.fields,
  success: IdentitySessionMessageSchema.SucceededLogin,
  failure: IdentitySessionMessageSchema.Failed,
  execute: executeLogin,
  formatError: loginFailureMessage,
})

class LogoutArgs extends Schema.Class<LogoutArgs>("IdentitySessionLogoutArgs")({
  token: RedactedStringSchema,
}) {}

const executeLogout = Effect.fn("IdentitySession.executeLogout")(function* ({ token }: LogoutArgs) {
  const tokenValue = Redacted.value(token)
  const options = RpcBrowser.requestOptions(tokenValue)

  yield* pipe(
    Client,
    Effect.flatMap((client) => client["identity.logout"](undefined, options)),
    Effect.catchTag("Unauthenticated", () => Effect.void),
  )

  return {}
})

const Logout = RpcBrowser.command("IdentitySession.logout", {
  request: { key: "identity.session", concurrency: "exhaust" },
  args: LogoutArgs.fields,
  success: IdentitySessionMessageSchema.SucceededLogout,
  failure: IdentitySessionMessageSchema.Failed,
  execute: executeLogout,
})

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

const clear = (model: IdentitySessionModel) => {
  const reset = RpcBrowser.reset(model, {
    password: "",
    token: null,
    expiresAt: null,
    generation: model.generation + 1,
  })

  return IdentitySessionModelSchema.make(reset.model)
}

const result = (model: IdentitySessionModel) =>
  UpdateResultSchema.make({ model }) as UpdateReturn

const commanded = (
  model: IdentitySessionModel,
  commands: NonNullable<UpdateReturn["commands"]>,
) => UpdateResultSchema.make({ model, commands }) as UpdateReturn

const update = (model: IdentitySessionModel, message: IdentitySessionMessage) =>
  IdentitySessionMessageSchema.match<UpdateReturn>(message, {
    ChangedUsername: ({ value }) => {
      const pending = RpcBrowser.pending(model)

      const next = pending
        ? model
        : IdentitySessionModelSchema.make({ ...model, username: value })

      return result(next)
    },
    ChangedPassword: ({ value }) => {
      const pending = RpcBrowser.pending(model)

      const next = pending
        ? model
        : IdentitySessionModelSchema.make({ ...model, password: value })

      return result(next)
    },
    ClickedLogin: () => {
      const hasToken = Predicate.isNotNull(model.token)
      const pending = RpcBrowser.pending(model)
      const blocked = hasToken || pending
      if (blocked) return result(model)

      const password = Redacted.make(model.password)

      const started = Login.start(
        model,
        { username: model.username, password },
        { password: "" },
      )

      const next = IdentitySessionModelSchema.make(started.model)

      return commanded(next, started.commands)
    },
    ClickedLogout: () => {
      const missingToken = Predicate.isNull(model.token)
      const pending = RpcBrowser.pending(model)
      const blocked = missingToken || pending
      if (blocked) return result(model)

      const token = Redacted.make(model.token)
      const started = Logout.start(model, { token })
      const next = IdentitySessionModelSchema.make(started.model)

      return commanded(next, started.commands)
    },
    SucceededLogin: ({ request, session }) => {
      const generation = model.generation + 1
      const token = Redacted.value(session.token)
      const expiresAt = DateTime.formatIso(session.expiresAt)

      const settled = RpcBrowser.succeed(model, request, {
        password: "",
        token,
        expiresAt,
        generation,
      })

      if (!settled.accepted) return result(model)

      const command = Expire({ generation, expiresAt: session.expiresAt })
      const next = IdentitySessionModelSchema.make(settled.model)
      return commanded(next, [command])
    },
    SucceededLogout: ({ request }) => {
      const settled = RpcBrowser.succeed(model, request)
      const next = settled.accepted ? clear(settled.model) : model
      return result(next)
    },
    Failed: ({ request, error }) => {
      const settled = RpcBrowser.fail(model, request, error, { password: "" })
      const next = IdentitySessionModelSchema.make(settled.model)
      return result(next)
    },
    Expired: ({ generation }) => {
      const current = sameGeneration(model.generation, generation)
      const next = current ? clear(model) : model
      return result(next)
    },
  })


const generationChanged = (
  previous: IdentitySessionModel,
  current: IdentitySessionModel,
) => !sameGeneration(previous.generation, current.generation)

const embed = <ParentMessage>(
  model: IdentitySessionModel,
  message: IdentitySessionMessage,
  toParent: (message: IdentitySessionMessage) => ParentMessage,
) => {
  const child = update(model, message)
  const commands = Command.mapMessages(child.commands, toParent)

  return UpdateResultSchema.make({ model: child.model, commands }) as
    Omit<Update.Return<IdentitySessionModel, ParentMessage, Type<typeof Client>>, "commands"> &
    Readonly<{ commands: typeof commands }>
}

export const IdentitySession = {
  Client,
  ModelSchema: IdentitySessionModelSchema,
  MessageSchema: IdentitySessionMessageSchema,
  empty,
  update,
  embed,
  generationChanged,
  pending: Login.pending,
  token: Struct.get<IdentitySessionModel, "token">("token"),
  expiresAt: Struct.get<IdentitySessionModel, "expiresAt">("expiresAt"),
  generation: Struct.get<IdentitySessionModel, "generation">("generation"),
}
