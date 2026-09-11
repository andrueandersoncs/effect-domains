import { Clock, DateTime, Effect, Option, Redacted, Schema, pipe } from "effect"
import { Command, type Update } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { CredentialsSchema, IssuedSessionSchema } from "effect-domains/identity"
import { IdentityRpcs } from "effect-domains/identity-rpc"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { field, notice, primaryButton, quietButton, textInput } from "./html.ts"
import { bearer, formatRpcError } from "./rpc.ts"
import { Requests, RequestStateSchema, RequestTokenSchema } from "./requests.ts"

export const SessionClient = RpcService.make({ name: "example-web/SessionClient", group: IdentityRpcs })
export type SessionClient = Type<typeof SessionClient>

export const SessionModel = Schema.Struct({
  username: Schema.String,
  password: Schema.String,
  token: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  requests: RequestStateSchema,
})
type Model = typeof SessionModel.Type

export const SessionMessage = defineMessageUnion({
  ChangedUsername: { value: Schema.String },
  ChangedPassword: { value: Schema.String },
  ClickedLogin: {},
  ClickedLogout: {},
  SucceededLogin: { request: RequestTokenSchema, session: Schema.toType(IssuedSessionSchema) },
  SucceededLogout: { request: RequestTokenSchema },
  Failed: { request: RequestTokenSchema, error: Schema.String },
  Expired: { generation: Schema.Int },
})
type Message = typeof SessionMessage.Type

const Login = Command.define("Session.login", {
  args: { request: RequestTokenSchema, username: Schema.String, password: Schema.Redacted(Schema.String) },
  messages: [SessionMessage.SucceededLogin, SessionMessage.Failed],
  execute: ({ request, username, password }) => pipe(
    Effect.gen(function* () {
      const credentials = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(CredentialsSchema))({
        username: username.trim(), password: Redacted.value(password),
      })
      const client = yield* SessionClient
      return yield* client["identity.login"](credentials)
    }),
    Effect.match({
      onSuccess: (session) => SessionMessage.SucceededLogin({ request, session }),
      onFailure: (error) => SessionMessage.Failed({ request, error: error._tag === "Unauthenticated"
        ? "Invalid username or password."
        : error._tag === "SchemaError" ? "Enter a valid username and password." : formatRpcError(error) }),
    }),
  ),
})

const Logout = Command.define("Session.logout", {
  args: { request: RequestTokenSchema, token: Schema.Redacted(Schema.String) },
  messages: [SessionMessage.SucceededLogout, SessionMessage.Failed],
  execute: ({ request, token }) => pipe(
    Effect.gen(function* () {
      const client = yield* SessionClient
      yield* client["identity.logout"](undefined, bearer(Redacted.value(token)))
    }),
    Effect.catchTag("Unauthenticated", () => Effect.void),
    Effect.match({
      onSuccess: () => SessionMessage.SucceededLogout({ request }),
      onFailure: (error) => SessionMessage.Failed({ request, error: formatRpcError(error) }),
    }),
  ),
})

const Expire = Command.define("Session.expire", {
  args: { generation: Schema.Int, expiresAt: Schema.DateTimeUtc },
  messages: [SessionMessage.Expired],
  execute: ({ generation, expiresAt }) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* Effect.sleep(Math.max(0, DateTime.toEpochMillis(expiresAt) - now))
    return SessionMessage.Expired({ generation })
  }),
})

const empty = (): Model => ({
  username: "", password: "", token: null, expiresAt: null, generation: 0, requests: Requests.empty(),
})

const clear = (model: Model): Model => ({
  ...model, password: "", token: null, expiresAt: null, generation: model.generation + 1,
  requests: Requests.reset(model.requests),
})

const update = (model: Model, message: Message): Update.Return<Model, Message, SessionClient> =>
  SessionMessage.match<Update.Return<Model, Message, SessionClient>>(message, {
    ChangedUsername: ({ value }) => ({ model: Requests.pending(model.requests) ? model : { ...model, username: value } }),
    ChangedPassword: ({ value }) => ({ model: Requests.pending(model.requests) ? model : { ...model, password: value } }),
    ClickedLogin: () => {
      if (model.token !== null || Requests.pending(model.requests)) return { model }
      const started = Requests.start(model.requests, "session")
      return {
        model: { ...model, password: "", requests: started.state },
        commands: [Login({ request: started.request, username: model.username, password: Redacted.make(model.password) })],
      }
    },
    ClickedLogout: () => {
      if (model.token === null || Requests.pending(model.requests)) return { model }
      const started = Requests.start(model.requests, "session")
      return {
        model: { ...model, requests: started.state },
        commands: [Logout({ request: started.request, token: Redacted.make(model.token) })],
      }
    },
    SucceededLogin: ({ request, session }) => {
      if (!Requests.accepts(model.requests, request)) return { model }
      const generation = model.generation + 1
      return {
        model: { ...model, password: "", token: Redacted.value(session.token), expiresAt: DateTime.formatIso(session.expiresAt), generation,
          requests: Requests.succeed(model.requests, request) },
        commands: [Expire({ generation, expiresAt: session.expiresAt })],
      }
    },
    SucceededLogout: ({ request }) => ({ model: Requests.accepts(model.requests, request) ? clear(model) : model }),
    Failed: ({ request, error }) => ({ model: Requests.accepts(model.requests, request)
      ? { ...model, password: "", requests: Requests.fail(model.requests, request, error) } : model }),
    Expired: ({ generation }) => ({ model: model.generation === generation ? clear(model) : model }),
  })

const view = <Parent>(h: HtmlBuilder<Parent>, model: Model, onMessage: (message: Message) => Parent) => {
  const busy = Requests.pending(model.requests)
  const error = model.requests.errors["session"]
  const status = error === undefined ? h.empty : notice(h, "error", error)
  if (model.token !== null) {
    return h.section([h.Class("session stack"), h.AriaLabel("Session")], [
      h.p([], [`Signed in as ${model.username}.`]),
      h.p([], [`Expires ${model.expiresAt}.`]),
      quietButton(h, { label: busy ? "Signing out…" : "Sign out", message: onMessage(SessionMessage.ClickedLogout()), disabled: busy }),
      status,
    ])
  }
  return h.form([h.Class("session stack"), h.OnSubmit(onMessage(SessionMessage.ClickedLogin()))], [
    field(h, { id: "session-username", label: "Username", children: textInput(h, {
      id: "session-username", value: model.username, type: "text", placeholder: "", autocomplete: "username",
      onInput: (value) => onMessage(SessionMessage.ChangedUsername({ value })),
    }) }),
    field(h, { id: "session-password", label: "Password", children: textInput(h, {
      id: "session-password", value: model.password, type: "password", placeholder: "", autocomplete: "current-password",
      onInput: (value) => onMessage(SessionMessage.ChangedPassword({ value })),
    }) }),
    primaryButton(h, { label: busy ? "Signing in…" : "Sign in", message: Option.none(), type: "submit",
      disabled: busy || model.username.trim() === "" || model.password === "" }),
    status,
  ])
}

export const Session = { empty, update, view, token: (model: Model) => model.token, generation: (model: Model) => model.generation }
