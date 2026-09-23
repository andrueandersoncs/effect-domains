export const applicationUiPaths = (path: `/${string}`) => {
  const root = path === "/"
  const prefix = root ? "" : path

  // SAFETY: Every generated value preserves the path type because `path` starts with a slash.
  return Object.freeze({
    document: path,
    javascript: `${prefix}/client.js` as `/${string}`,
    stylesheet: `${prefix}/style.css` as `/${string}`,
    api: `${prefix}/api` as `/${string}`,
    call: `${prefix}/api/call` as `/${string}`,
  })
}
