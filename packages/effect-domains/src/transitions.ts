import { Array, Effect, Option, Predicate, Record, Schema, Struct, flow, pipe } from "effect"

/** One declared edge: the action is allowed from any `from` status and lands on `to`. */
type TransitionDeclaration<Status extends string = string> = Readonly<{
  readonly from: ReadonlyArray<Status>
  readonly to: Status
}>

type TransitionDeclarations<Status extends string = string> = Readonly<Record<string, TransitionDeclaration<Status>>>

const TransitionErrorFields = {
  key: Schema.String,
  action: Schema.String,
  actual: Schema.String,
  message: Schema.String,
}

type TransitionError = Schema.Schema.Type<
  ReturnType<typeof Schema.TaggedError<Readonly<{
    readonly _tag: string
    readonly key: string
    readonly action: string
    readonly actual: string
    readonly message: string
  }>>>
>

/** The structural transition intent consumed by the Resource compiler. */
export interface TransitionMachine {
  readonly name: string
  readonly field: string
  readonly status: Schema.Schema<string>
  readonly actions: Schema.Schema<string>
  readonly Error: Schema.Top
  readonly guard: (action: never, key: string, actual: string) => Effect.Effect<string, unknown>
  readonly invalid: (action: string, key: string, actual: string) => unknown
  readonly inspection: unknown
}

class TransitionDefinitionError extends Schema.TaggedError<TransitionDefinitionError>()(
  "TransitionDefinitionError",
  { name: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `Invalid transitions for ${this.name}: ${this.reason}`
  }
}

const definitionFailure = (name: string, reason: string) =>
  pipe(TransitionDefinitionError.make({ name, reason }), Effect.fail)

const validateDeclarations = Effect.fn("Transitions.validateDeclarations")(function* (
  name: string,
  isStatus: (value: unknown) => boolean,
  declarations: TransitionDeclarations,
) {
  const entries = Record.toEntries(declarations)

  if (Array.isReadonlyArrayEmpty(entries)) return yield* definitionFailure(name, "must declare at least one transition")

  yield* Effect.forEach(entries, ([action, declaration]) => {
    if (Array.isReadonlyArrayEmpty(declaration.from)) {
      return definitionFailure(name, `transition ${action} must declare at least one source status`)
    }

    if (!isStatus(declaration.to)) {
      return definitionFailure(name, `transition ${action} declares a status outside the status schema`)
    }

    const knownSources = Array.every(declaration.from, isStatus)

    return knownSources ? Effect.void : definitionFailure(name, `transition ${action} declares a status outside the status schema`)
  }, { discard: true })
})

const freezeDeclaration = <Status extends string>(declaration: TransitionDeclaration<Status>) => {
  const copiedFrom = Array.copy(declaration.from)
  const from = Object.freeze(copiedFrom)

  return Object.freeze({ from, to: declaration.to })
}

const arrayValues = (values: unknown) => {
  if (Array.isArray(values)) return Option.some(values)
  return Option.none<ReadonlyArray<unknown>>()
}
const allStrings = (values: ReadonlyArray<unknown>) => Array.every(values, Predicate.isString)
const nonEmptyArrayValues = flow(arrayValues, Option.filter(Array.isReadonlyArrayNonEmpty))
const stringValues = flow(nonEmptyArrayValues, Option.exists(allStrings))

const statusValues = (status: Schema.Schema<string>) => {
  const document = Schema.toJsonSchemaDocument(status)
  const values = Predicate.hasProperty(document.schema, "enum") ? Option.some(document.schema.enum) : Option.none()

  return pipe(values, Option.filter(stringValues))
}

/**
 * Declares a status machine for one canonical literal field. The graph is authored; the
 * guard, the conditional write, and the error shape are derived from it.
 */
const make = <
  const Name extends string,
  const Field extends string,
  const Status extends Schema.Schema<string>,
  const Declarations extends TransitionDeclarations<Status["Type"]>,
>(input: Readonly<{ name: Name; field: Field; status: Status; transitions: Declarations }>) => {
  type Action = Extract<keyof Declarations, string>
  type Target<A extends Action> = Declarations[A]["to"]
  type Applied<Row, A extends Action> = Omit<Row, Field> & Readonly<Record<Field, Target<A>>>

  const literals = statusValues(input.status)

  if (Option.isNone(literals)) {
    const invalidStatus = definitionFailure(input.name, "status must be a non-empty string literal schema")

    Effect.runSync(Effect.orDie(invalidStatus))
  }

  const isStatus = Schema.is(input.status)
  const validDeclarations = validateDeclarations(input.name, isStatus, input.transitions)

  Effect.runSync(validDeclarations)

  const tag = `Invalid${input.name}Transition` as const

  const ErrorSchema = Schema.TaggedError<Readonly<{
    _tag: `Invalid${Name}Transition`
    key: string
    action: string
    actual: string
    message: string
  }>>()(tag, TransitionErrorFields)

  const frozenTransitions = Record.map(input.transitions, freezeDeclaration)
  // SAFETY: The frozen map retains Declarations because Record.map preserves every key while freezing changes only mutability.
  const transitions = Object.freeze(frozenTransitions) as Declarations
  // SAFETY: Every returned key is an Action because transitions has the exact Declarations key set.
  const actions = Record.keys(transitions) as Array<Action>
  // SAFETY: The literals enumerate every Action because actions was derived from the exact Declarations key set.
  const ActionsSchema = Schema.Literals(actions) as Schema.Literals<ReadonlyArray<Action>>

  const invalid = (action: string, key: string, actual: string) =>
    ErrorSchema.make({ key, action, actual, message: `${input.name} ${key} cannot ${action} while ${actual}` })

  const allows = (actual: string) => (entry: TransitionDeclaration<Status["Type"]>) =>
    // SAFETY: The status has the declared status type because callers pass the value read from the typed transition field.
    Array.contains(entry.from, actual as Status["Type"])

  const guard = <A extends Action>(action: A, key: string, actual: string): Effect.Effect<Target<A>, Schema.Schema.Type<typeof ErrorSchema>> => {
    const declaration = Record.get(transitions, action)
    const applicable = pipe(declaration, Option.filter(allows(actual)))
    const failure = invalid(action, key, actual)

    return pipe(
      applicable,
      Option.match({
        onNone: () => Effect.fail(failure),
        // SAFETY: The target belongs to action A because entry was selected from transitions by that action key.
        onSome: (entry) => Effect.succeed(entry.to as Target<A>),
      }),
    )
  }

  const applyTo = <Row extends Readonly<Record<Field, Status["Type"]>>, A extends Action>(row: Row) =>
    // SAFETY: The result is Applied<Row, A> because Struct.assign updates exactly the declared transition field with Target<A>.
    (to: Target<A>) => Struct.assign(row, { [input.field]: to }) as Applied<Row, A>

  const apply = <A extends Action>(action: A, key: string) =>
    <Row extends Readonly<Record<Field, Status["Type"]>>>(row: Row) =>
      pipe(
        guard(action, key, row[input.field]),
        Effect.map(applyTo<Row, A>(row)),
      )

  const inspection = Object.freeze({ field: input.field, transitions })

  const definition = {
    name: input.name,
    field: input.field,
    status: input.status,
    transitions,
    actions: ActionsSchema,
    Error: ErrorSchema,
    guard,
    apply,
    invalid,
    inspection,
  }

  return Object.freeze(definition)
}

export const Transitions = { make }
