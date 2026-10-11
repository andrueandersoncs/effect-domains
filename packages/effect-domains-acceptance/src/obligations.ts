import type { Catalog } from "./model.ts"

const id = "effect-domains-platform-obligations"
const revision = "1"
const provenance = "docs/wiki/story-driven-acceptance.md#observation-and-evaluation"
const approval = "approved"

/** Shared obligations are declared once and refined by applications because a reusable promise must be referenced, not copied into every story. */
export const platformObligations: typeof Catalog.Encoded = {
  id,
  revision,
  provenance,
  approval,
  imports: [],
  approvals: [{
    id: "platform-obligations-1",
    by: "implementation agent restating user-approved design text",
    on: "2026-10-10",
    basis: "Accepted story-driven acceptance design approved on 2026-10-08 (docs/wiki/story-driven-acceptance.md#declarative-product-model): shared platform contracts are referenced with parameter bindings rather than copied, and preservation of unrelated records is an observation-and-evaluation obligation; recorded by AP-12 from the preservation obligations both slices already approved.",
    approves: [`${id}@${revision}`, "PLATFORM-PRESERVE@1"],
  }, {
    id: "platform-obligations-user-approval",
    by: "user",
    on: "2026-10-11",
    basis: "The user approved PLATFORM-PRESERVE as recorded in the 2026-10-11 review of the AP-17 open items.",
    approves: [`${id}@${revision}`, "PLATFORM-PRESERVE@1"],
  }],
  actors: [],
  contexts: [],
  needs: [],
  capabilities: [],
  features: [],
  textFixtures: [],
  rubrics: [],
  requirements: [{
    id: "PLATFORM-PRESERVE",
    revision,
    provenance,
    approval,
    text: "Records outside the declared subject of an exercised obligation keep their identity, values, and history.",
    category: "preservation",
    parameters: [{ name: "scope", description: "the observed records that must be preserved" }],
  }],
  stories: [],
  scenarios: [],
}
