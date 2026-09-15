export const ApplicationUiAssetFiles = {
  javascript: new URL("./dist/client.js", import.meta.url),
  stylesheet: new URL("./dist/style.css", import.meta.url),
} as const
