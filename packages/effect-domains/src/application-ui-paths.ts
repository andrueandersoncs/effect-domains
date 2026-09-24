import { Equivalence } from "effect"

export const applicationUiPaths = (path: `/${string}`) => {
  const root = Equivalence.strictEqual()(path, "/")
  const prefix = root ? "" : path
  const javascript: `/${string}` = `${prefix}/client.js`
  const stylesheet: `/${string}` = `${prefix}/style.css`
  const api: `/${string}` = `${prefix}/api`
  const call: `/${string}` = `${prefix}/api/call`

  return Object.freeze({
    document: path,
    javascript,
    stylesheet,
    api,
    call,
  })
}
