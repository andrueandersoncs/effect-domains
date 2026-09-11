import { Layer } from "effect"
import { Runtime } from "foldkit"
import { browserLayer } from "@effect-domains/example-web/rpc"
import { SessionClient } from "@effect-domains/example-web/session"
import { Model, WebClient, init, update, view } from "./main.ts"

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById("root"),
  resources: Layer.mergeAll(browserLayer(WebClient), browserLayer(SessionClient)),
  devTools: false,
})

Runtime.run(application)
