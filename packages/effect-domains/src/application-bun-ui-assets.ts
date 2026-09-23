import { ApplicationUiAssetFiles } from "@effect-domains/application-ui/assets"
import { Effect, Schema } from "effect"

export class ApplicationUiAssetsError extends Schema.TaggedError<ApplicationUiAssetsError>()(
  "ApplicationBunUiAssetsError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

const maximumUiAssetBytes = 4 * 1024 * 1024

const readApplicationUiAsset = Effect.fn("ApplicationBun.readApplicationUiAsset")(function* (file: URL) {
  const asset = Bun.file(file)
  const boundedAsset = asset.slice(0, maximumUiAssetBytes + 1)

  const bytes = yield* Effect.tryPromise({
    try: () => boundedAsset.arrayBuffer(),
    catch: (cause) => ApplicationUiAssetsError.make({
      reason: `Could not read prebuilt application UI asset ${file.pathname}. Run \`bun run build\` before serving with the application UI enabled. ${String(cause)}`,
    }),
  })

  if (bytes.byteLength > maximumUiAssetBytes) {
    return yield* ApplicationUiAssetsError.make({
      reason: `Prebuilt application UI asset ${file.pathname} exceeds ${maximumUiAssetBytes} bytes`,
    })
  }

  return new TextDecoder().decode(bytes)
})

export const readApplicationUiAssets = Effect.fn("ApplicationBun.readApplicationUiAssets")(function* () {
  const javascript = readApplicationUiAsset(ApplicationUiAssetFiles.javascript)
  const stylesheet = readApplicationUiAsset(ApplicationUiAssetFiles.stylesheet)

  return yield* Effect.all({ javascript, stylesheet }, { concurrency: "unbounded" })
})
