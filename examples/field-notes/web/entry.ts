import { Layer } from "effect"
import { Runtime } from "foldkit"
import { SessionClient } from "@effect-domains/example-web/session"
import { Model, WebClient, init, update, view } from "./main.ts"

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById("root"),
  resources: Layer.mergeAll(WebClient.layer, SessionClient.layer),
  devTools: false,
})

Runtime.run(application)
