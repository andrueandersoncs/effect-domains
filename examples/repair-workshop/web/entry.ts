import { Runtime } from "foldkit"
import { browserLayer } from "@effect-domains/example-web/rpc"
import { Model, init, update, view, WebClient } from "./main.ts"

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById("root"),
  resources: browserLayer(WebClient),
})

Runtime.run(application)
