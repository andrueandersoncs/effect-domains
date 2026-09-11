import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { AssetSchema } from "./domain.ts"

export const AssetsResource = Resource.make({
  authorization: Authorization.public,
  name: "assets",
  schema: AssetSchema,
  operations: {
    ...Resource.crud,
    list: { filter: ["assetTag", "location", "condition"], limit: 100 },
  },
  relations: {
    unique: [{ fields: ["assetTag"] }],
    indexes: [{ fields: ["location", "condition"] }],
  },
})
