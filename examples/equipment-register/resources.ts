import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { AssetSchema } from "./domain.ts"

export const AssetsResource = Resource.define({
  authorization: Authorization.public,
  name: "assets",
  schema: AssetSchema,
  capabilities: Resource.capabilities(
    Resource.get(),
    Resource.list({ filter: ["assetTag", "location", "condition"], limit: 100 }),
    Resource.create(),
    Resource.update(),
    Resource.remove(),
  ),
  relations: {
    unique: [{ fields: ["assetTag"] }],
    indexes: [{ fields: ["location", "condition"] }],
  },
})
