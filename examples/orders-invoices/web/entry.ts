import { Effect, Layer } from "effect"
import { BrowserRuntime } from "effect-domains/browser-runtime"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { IdentitySession as Session } from "effect-domains/identity-session"
import { Model, WebClient, init, update, view } from "./main.ts"

Effect.runSync(BrowserRuntime.run({
  Model,
  init,
  update,
  view,
  resources: Layer.mergeAll(RpcBrowser.layer(WebClient), RpcBrowser.layer(Session.Client)),
  devTools: false,
}))


