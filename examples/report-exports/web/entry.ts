import { Layer } from "effect"
import { Runtime } from "foldkit"
import { browserLayer } from "@effect-domains/example-web/rpc"
import { Model, init, update, view, WebClient } from "./main.ts"
import { SessionClient } from "@effect-domains/example-web/session"

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById("root"),
  resources: Layer.merge(browserLayer(WebClient), browserLayer(SessionClient)),
  devTools: false,
})

Runtime.run(application)
