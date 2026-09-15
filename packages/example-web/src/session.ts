import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { IdentitySession } from "effect-domains/identity-session"
import { field, notice, primaryButton, quietButton, textInput } from "./html.ts"

type Model = typeof IdentitySession.ModelSchema.Type
type Message = typeof IdentitySession.MessageSchema.Type

export const identitySessionView = <Parent>(
  h: HtmlBuilder<Parent>,
  model: Model,
  onMessage: (message: Message) => Parent,
) => {
  const busy = IdentitySession.pending(model)
  const error = model.requests.errors["identity.session"]
  const status = error === undefined ? h.empty : notice(h, "error", error)
  if (model.token !== null) {
    return h.section([h.Class("session stack"), h.AriaLabel("Session")], [
      h.p([], [`Signed in as ${model.username}.`]),
      h.p([], [`Expires ${model.expiresAt}.`]),
      quietButton(h, { label: busy ? "Signing out…" : "Sign out", message: onMessage(IdentitySession.MessageSchema.ClickedLogout()), disabled: busy }),
      status,
    ])
  }
  return h.form([h.Class("session stack"), h.OnSubmit(onMessage(IdentitySession.MessageSchema.ClickedLogin()))], [
    field(h, { id: "session-username", label: "Username", children: textInput(h, {
      id: "session-username", value: model.username, type: "text", placeholder: "", autocomplete: "username",
      onInput: (value) => onMessage(IdentitySession.MessageSchema.ChangedUsername({ value })),
    }) }),
    field(h, { id: "session-password", label: "Password", children: textInput(h, {
      id: "session-password", value: model.password, type: "password", placeholder: "", autocomplete: "current-password",
      onInput: (value) => onMessage(IdentitySession.MessageSchema.ChangedPassword({ value })),
    }) }),
    primaryButton(h, { label: busy ? "Signing in…" : "Sign in", message: Option.none(), type: "submit",
      disabled: busy || model.username.trim() === "" || model.password === "" }),
    status,
  ])
}
