import { Effect } from "effect"
import { BrowserRuntime } from "effect-domains/browser-runtime"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { Model, init, update, view, WebClient } from "./main.ts"

Effect.runSync(BrowserRuntime.run({
  Model,
  init,
  update,
  view,
  resources: RpcBrowser.layer(WebClient),
}))


