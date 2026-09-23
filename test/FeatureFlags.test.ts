import { expect, it } from "@effect/vitest"
import { Array, Effect, Layer, pipe } from "effect"
import { Application, Part } from "effect-domains/application"
import { ApplicationInspect } from "effect-domains/application-inspect"
import { FeatureFlags } from "effect-domains/feature-flags"

const NewCheckout = FeatureFlags.define({
  name: "new-checkout",
  default: false,
  description: "Use the replacement checkout flow",
})

const SearchSuggestions = FeatureFlags.define({
  name: "search-suggestions",
  default: true,
})

const checkoutFlagPart = Part.featureFlag(NewCheckout)

const checkoutDomain = Application.define({
  name: "checkout",
  parts: [checkoutFlagPart],
})

const suggestionsFlagPart = Part.featureFlag(SearchSuggestions)
const checkoutApplicationPart = Part.application(checkoutDomain)

const applicationDefinition = Application.define({
  name: "storefront",
  parts: [suggestionsFlagPart, checkoutApplicationPart],
})

const application = Effect.runSync(Application.compile(applicationDefinition))
const expectedFlags = [SearchSuggestions, NewCheckout]

const expectedInspection = [
  { name: "search-suggestions", default: true },
  {
    name: "new-checkout",
    default: false,
    description: "Use the replacement checkout flow",
  },
]

it("compiles nested feature flag declarations into inspectable application metadata", () => {
  const inspection = Effect.runSync(ApplicationInspect.describe(application))

  expect(application.featureFlags).toEqual(expectedFlags)
  expect(inspection.featureFlags).toEqual(expectedInspection)

  const replacement = FeatureFlags.define({ name: "new-checkout", default: true })
  const originalPart = Part.featureFlag(NewCheckout)
  const replacementPart = Part.featureFlag(replacement)

  const duplicate = Application.define({
    name: "duplicate-flags",
    parts: [originalPart, replacementPart],
  })

  expect(() => Effect.runSync(Application.compile(duplicate))).toThrow("duplicate feature flag name new-checkout")
})

const overrides = [[SearchSuggestions, false]] as const
const featureFlagRuntime = FeatureFlags.layerMemory(application.featureFlags, overrides)

it.effect("enables, disables, overrides, and atomically toggles declared flags", () => pipe(
  Effect.gen(function* () {
    const initialCheckout = yield* FeatureFlags.isEnabled(NewCheckout)
    const initialSuggestions = yield* FeatureFlags.isEnabled(SearchSuggestions)

    expect(initialCheckout).toBe(false)
    expect(initialSuggestions).toBe(false)

    yield* FeatureFlags.enable(NewCheckout)

    const enabledCheckout = yield* FeatureFlags.isEnabled(NewCheckout)

    expect(enabledCheckout).toBe(true)

    yield* FeatureFlags.disable(NewCheckout)

    const disabledCheckout = yield* FeatureFlags.isEnabled(NewCheckout)

    expect(disabledCheckout).toBe(false)

    const toggle = FeatureFlags.toggle(NewCheckout)
    const toggles = Array.replicate(toggle, 100)

    yield* Effect.all(toggles, { concurrency: "unbounded" })

    const checkoutAfterToggles = yield* FeatureFlags.isEnabled(NewCheckout)

    expect(checkoutAfterToggles).toBe(false)

    const replacement = FeatureFlags.define({ name: "new-checkout", default: false })
    const unavailable = yield* pipe(FeatureFlags.isEnabled(replacement), Effect.flip)

    expect(unavailable).toMatchObject({ _tag: "FeatureFlagUnavailable", name: "new-checkout" })
  }),
  Effect.provide(featureFlagRuntime),
))

it.effect("reports invalid overrides through layer acquisition", Effect.fn(
  "FeatureFlags.invalidOverrides",
)(function* () {
  const replacement = FeatureFlags.define({ name: "new-checkout", default: false })

  const invalidRuntime = FeatureFlags.layerMemory(
    application.featureFlags,
    [[replacement, true]],
  )

  const failure = yield* pipe(Layer.build(invalidRuntime), Effect.scoped, Effect.flip)

  expect(failure).toMatchObject({
    _tag: "FeatureFlagDefinitionError",
    reason: "override references undeclared feature flag new-checkout",
  })
}))
