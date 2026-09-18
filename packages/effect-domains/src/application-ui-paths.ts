import { Data, Equivalence } from "effect"

const sameString = Equivalence.strictEqual<string>()

class ApplicationUiPaths extends Data.Class<{
  readonly document: `/${string}`
  readonly javascript: `/${string}`
  readonly stylesheet: `/${string}`
  readonly api: `/${string}`
  readonly call: `/${string}`
}> {}

export const applicationUiPaths = (path: `/${string}`) => {
  const nestedPath = (name: string) => (sameString(path, "/") ? `/${name}` : `${path}/${name}`) as `/${string}`
  const javascript = nestedPath("client.js")
  const stylesheet = nestedPath("style.css")
  const api = nestedPath("api")
  const call = nestedPath("api/call")

  return new ApplicationUiPaths({
    document: path,
    javascript,
    stylesheet,
    api,
    call,
  })
}
