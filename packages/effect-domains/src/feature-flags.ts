import { Array, Context, Effect, Equivalence, Function, HashMap, Layer, Option, Ref, Schema, Struct, pipe } from "effect"

export type FeatureFlag<Name extends string = string> = Readonly<{
  readonly name: Name
  readonly default: boolean
}> & Readonly<Partial<{
  readonly description: string
}>>

type FeatureFlagOverrides<Flags extends ReadonlyArray<FeatureFlag>> = ReadonlyArray<
  readonly [flag: Flags[number], enabled: boolean]
>

class FeatureFlagUnavailable extends Schema.TaggedError<FeatureFlagUnavailable>()(
  "FeatureFlagUnavailable",
  { name: Schema.String },
) {}

class FeatureFlagDefinitionError extends Schema.TaggedError<FeatureFlagDefinitionError>()(
  "FeatureFlagDefinitionError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

const define = <const Name extends string>(
  definition: FeatureFlag<Name>,
): FeatureFlag<Name> => pipe(
  Option.fromUndefinedOr(definition.description),
  Option.match({
    onNone: () => Object.freeze({
      name: definition.name,
      default: definition.default,
    }),
    onSome: (description) => Object.freeze({
      name: definition.name,
      default: definition.default,
      description,
    }),
  }),
)

const flagsEqual = Equivalence.strictEqual<FeatureFlag>()

const isBlankFlagName = (name: string) => {
  const trimmed = name.trim()

  return Equivalence.strictEqual<string>()(trimmed, "")
}

const validate = Effect.fn("FeatureFlags.validate")(function* (
  flags: ReadonlyArray<FeatureFlag>,
) {
  const names = Array.map(flags, Struct.get("name"))
  const nameCounts = new Map<string, number>()

  for (const name of names) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }

  const empty = Array.findFirst(names, isBlankFlagName)
  const duplicate = Array.findFirst(names, (name) => (nameCounts.get(name) ?? 0) > 1)
  const problem = Option.orElse(empty, Function.constant(duplicate))

  if (Option.isSome(problem)) {
    const reason = isBlankFlagName(problem.value)
      ? "feature flag name must not be empty"
      : `duplicate feature flag name ${problem.value}`

    return yield* FeatureFlagDefinitionError.make({ reason })
  }
})

const compileFlags = Effect.fn("FeatureFlags.compile")((
  declarations: ReadonlyArray<FeatureFlag>,
) => {
  const flags = Object.freeze([...declarations])

  return pipe(validate(flags), Effect.as(flags))
})

const unavailableFor = (flag: FeatureFlag) => () =>
  FeatureFlagUnavailable.make({ name: flag.name })

const requireRegistered = Effect.fn("FeatureFlags.requireRegistered")((
  registered: ReadonlyArray<FeatureFlag>,
  flag: FeatureFlag,
) => pipe(
  Array.findFirst(registered, (candidate) => flagsEqual(candidate, flag)),
  Effect.fromOption,
  Effect.mapError(unavailableFor(flag)),
))

const stateFor = (flag: FeatureFlag) => (
  current: HashMap.HashMap<string, boolean>,
) => pipe(
  HashMap.get(current, flag.name),
  Effect.fromOption,
  Effect.mapError(unavailableFor(flag)),
)

const layerMemory = <const Flags extends ReadonlyArray<FeatureFlag>>(
  declarations: Flags,
  overrides: FeatureFlagOverrides<Flags> = [],
): Layer.Layer<FeatureFlags, FeatureFlagDefinitionError> => {
  const make = Effect.gen(function* () {
    const flags = yield* compileFlags(declarations)
    const registered = new Set(flags)
    const overrideCounts = new Map<FeatureFlag, number>()

    for (const [flag] of overrides) {
      overrideCounts.set(flag, (overrideCounts.get(flag) ?? 0) + 1)
    }

    const overrideByFlag = new Map(overrides)
    const unknownOverride = Array.findFirst(overrides, ([flag]) => !registered.has(flag))
    const duplicateOverride = Array.findFirst(overrides, ([flag]) => (overrideCounts.get(flag) ?? 0) > 1)

    if (Option.isSome(unknownOverride)) {
      const [flag] = unknownOverride.value

      return yield* FeatureFlagDefinitionError.make({
        reason: `override references undeclared feature flag ${flag.name}`,
      })
    }

    if (Option.isSome(duplicateOverride)) {
      const [flag] = duplicateOverride.value

      return yield* FeatureFlagDefinitionError.make({
        reason: `duplicate override for feature flag ${flag.name}`,
      })
    }

    const initialEntry = (flag: FeatureFlag): readonly [string, boolean] => {
      const enabled = overrideByFlag.get(flag) ?? flag.default

      return [flag.name, enabled]
    }

    const initialEntries = Array.map(flags, initialEntry)
    const initial = HashMap.fromIterable(initialEntries)
    const states = yield* Ref.make(initial)

    const isEnabled = Effect.fn("FeatureFlags.isEnabled")(function* (flag: FeatureFlag) {
      yield* requireRegistered(flags, flag)

      return yield* pipe(Ref.get(states), Effect.flatMap(stateFor(flag)))
    })

    const setEnabled = Effect.fn("FeatureFlags.setEnabled")(function* (
      flag: FeatureFlag,
      enabled: boolean,
    ) {
      yield* requireRegistered(flags, flag)
      yield* Ref.update(states, HashMap.set(flag.name, enabled))
    })

    const toggle = Effect.fn("FeatureFlags.toggle")(function* (flag: FeatureFlag) {
      yield* requireRegistered(flags, flag)

      return yield* Ref.modify(states, (current) => {
        const enabled = pipe(HashMap.get(current, flag.name), Option.getOrElse(() => flag.default))
        const next = !enabled

        return [next, HashMap.set(current, flag.name, next)] as const
      })
    })

    return FeatureFlags.of({ isEnabled, setEnabled, toggle })
  })

  return Layer.effect(FeatureFlags, make)
}

export class FeatureFlags extends Context.Service<FeatureFlags, {
  readonly isEnabled: (flag: FeatureFlag) => Effect.Effect<boolean, FeatureFlagUnavailable>
  readonly setEnabled: (flag: FeatureFlag, enabled: boolean) => Effect.Effect<void, FeatureFlagUnavailable>
  readonly toggle: (flag: FeatureFlag) => Effect.Effect<boolean, FeatureFlagUnavailable>
}>()("@effect-domains/FeatureFlags") {
  static readonly define = define
  static readonly layerMemory = layerMemory
  static readonly compile = compileFlags

  static readonly isEnabled = Effect.fn("FeatureFlags.isEnabled")(function* (flag: FeatureFlag) {
    const featureFlags = yield* FeatureFlags

    return yield* featureFlags.isEnabled(flag)
  })

  static readonly setEnabled = Effect.fn("FeatureFlags.setEnabled")(function* (
    flag: FeatureFlag,
    enabled: boolean,
  ) {
    const featureFlags = yield* FeatureFlags

    return yield* featureFlags.setEnabled(flag, enabled)
  })

  static readonly enable = Effect.fn("FeatureFlags.enable")(function* (flag: FeatureFlag) {
    yield* FeatureFlags.setEnabled(flag, true)
  })

  static readonly disable = Effect.fn("FeatureFlags.disable")(function* (flag: FeatureFlag) {
    yield* FeatureFlags.setEnabled(flag, false)
  })

  static readonly toggle = Effect.fn("FeatureFlags.toggle")(function* (flag: FeatureFlag) {
    const featureFlags = yield* FeatureFlags

    return yield* featureFlags.toggle(flag)
  })
}
