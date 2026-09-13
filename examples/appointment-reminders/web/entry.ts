import { Effect, Layer } from "effect"
import { BrowserRuntime } from "effect-domains/browser-runtime"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { Model, init, update, view, WebClient } from "./main.ts"
import { IdentitySession as Session } from "effect-domains/identity-session"

Effect.runSync(BrowserRuntime.run({
  Model,
  init,
  update,
  view,
  resources: Layer.merge(RpcBrowser.layer(WebClient), RpcBrowser.layer(Session.Client)),
  devTools: false,
}))


