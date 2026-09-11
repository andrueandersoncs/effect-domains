import { WebClient } from "./main.ts"
import { Runtime } from "foldkit"
import { Model, init, update, view } from "./main.ts"

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById("root"),
  resources: WebClient.layer,
})

Runtime.run(application)
