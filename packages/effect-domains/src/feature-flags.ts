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

const incrementCount = (
  counts: HashMap.HashMap<string, number>,
  name: string,
) => {
  const count = pipe(HashMap.get(counts, name), Option.getOrElse(Function.constant(0)))

  return HashMap.set(counts, name, count + 1)
}

const noNameCounts = HashMap.empty<string, number>()

const validate = Effect.fn("FeatureFlags.validate")(function* (
  flags: ReadonlyArray<FeatureFlag>,
) {
  const names = Array.map(flags, Struct.get("name"))
  const nameCounts = Array.reduce(names, noNameCounts, incrementCount)
  const empty = Array.findFirst(names, isBlankFlagName)

  const duplicateName = (name: string) => pipe(
    HashMap.get(nameCounts, name),
    Option.exists((count) => count > 1),
  )

  const duplicate = Array.findFirst(names, duplicateName)
  const problem = Option.orElse(empty, Function.constant(duplicate))

  if (Option.isSome(problem)) {
    const reason = isBlankFlagName(problem.value)
      ? "feature flag name must not be empty"
      : `duplicate feature flag name ${problem.value}`

    return yield* FeatureFlagDefinitionError.make({ reason })
  }
})

const compileFlags = Effect.fn("FeatureFlags.compile")(function* (
  declarations: ReadonlyArray<FeatureFlag>,
) {
  const flags = Object.freeze([...declarations])

  yield* validate(flags)

  return flags
})

const unavailableFor = (flag: FeatureFlag) => () =>
  FeatureFlagUnavailable.make({ name: flag.name })

const requireRegistered = Effect.fn("FeatureFlags.requireRegistered")(function* (
  registered: ReadonlyArray<FeatureFlag>,
  flag: FeatureFlag,
) {
  const available = Array.findFirst(registered, (candidate) => flagsEqual(candidate, flag))

  return yield* pipe(
    available,
    Effect.fromOption,
    Effect.mapError(unavailableFor(flag)),
  )
})

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
    const overrideNames = Array.map(overrides, ([flag]) => flag.name)

    const overrideCounts = Array.reduce(
      overrideNames,
      noNameCounts,
      incrementCount,
    )

    const overrideEntry = ([flag, enabled]: FeatureFlagOverrides<Flags>[number]) => [flag.name, enabled] as const
    const overrideByName = pipe(overrides, Array.map(overrideEntry), HashMap.fromIterable)

    const unknownOverride = Array.findFirst(
      overrides,
      ([flag]) => !Array.containsWith(flagsEqual)(flags, flag),
    )

    const duplicateOverride = Array.findFirst(overrides, ([flag]) => pipe(
      HashMap.get(overrideCounts, flag.name),
      Option.exists((count) => count > 1),
    ))

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
      const enabled = pipe(
        HashMap.get(overrideByName, flag.name),
        Option.getOrElse(Function.constant(flag.default)),
      )

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
