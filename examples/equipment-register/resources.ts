import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { AssetSchema } from "./domain.ts"

const assetCapabilities = [
  Resource.get(),
  Resource.list({ filter: ["assetTag", "location", "condition"], limit: 100 }),
  Resource.create(),
  Resource.update(),
  Resource.remove(),
]

export const AssetsResource = Resource.define({
  authorization: Authorization.public,
  name: "assets",
  schema: AssetSchema,
  capabilities: assetCapabilities,
  relations: {
    unique: [{ fields: ["assetTag"] }],
    indexes: [{ fields: ["location", "condition"] }],
  },
})
