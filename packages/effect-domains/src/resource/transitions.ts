import { Array, Effect, Option, Predicate, Record, Schema, Struct, pipe } from "effect"

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

const validateDeclarations = (
  name: string,
  isStatus: (value: unknown) => boolean,
  declarations: TransitionDeclarations,
) => {
  const entries = Record.toEntries(declarations)

  if (Array.isReadonlyArrayEmpty(entries)) {
    const error = TransitionDefinitionError.make({ name, reason: "must declare at least one transition" })

    return Option.some(error)
  }

  const noFailure = Option.none<TransitionDefinitionError>()

  return Array.reduce(entries, noFailure, (failure, [action, declaration]) => {
    if (Option.isSome(failure)) return failure

    if (Array.isReadonlyArrayEmpty(declaration.from)) {
      const error = TransitionDefinitionError.make({ name, reason: `transition ${action} must declare at least one source status` })

      return Option.some(error)
    }

    if (!isStatus(declaration.to)) {
      const error = TransitionDefinitionError.make({ name, reason: `transition ${action} declares a status outside the status schema` })

      return Option.some(error)
    }

    const knownSources = Array.every(declaration.from, isStatus)

    if (!knownSources) {
      const error = TransitionDefinitionError.make({ name, reason: `transition ${action} declares a status outside the status schema` })

      return Option.some(error)
    }

    return failure
  })
}

const freezeDeclaration = <Status extends string>(declaration: TransitionDeclaration<Status>) => {
  const copiedFrom = Array.copy(declaration.from)
  const from = Object.freeze(copiedFrom)

  return Object.freeze({ from, to: declaration.to })
}

const arrayValues = (values: unknown) =>
  Array.isArray(values)
    ? Option.some(values)
    : Option.none<ReadonlyArray<unknown>>()

const allStrings = (values: ReadonlyArray<unknown>) => Array.every(values, Predicate.isString)

const statusValues = (status: Schema.Schema<string>) => {
  const document = Schema.toJsonSchemaDocument(status)
  const values = Predicate.hasProperty(document.schema, "enum") ? Option.some(document.schema.enum) : Option.none()

  return pipe(
    values,
    Option.flatMap(arrayValues),
    Option.filter(Array.isReadonlyArrayNonEmpty),
    Option.filter(allStrings),
  )
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
  type Applied<Row, A extends Action> = Row & Readonly<Record<Field, Target<A>>>

  const literals = statusValues(input.status)

  if (Option.isNone(literals)) {
    const invalidStatus = TransitionDefinitionError.make({
      name: input.name,
      reason: "status must be a non-empty string literal schema",
    })

    const invalidStatusFailure = Effect.fail(invalidStatus)
    const fatalInvalidStatus = Effect.orDie(invalidStatusFailure)

    Effect.runSync(fatalInvalidStatus)
  }

  const isStatus = Schema.is(input.status)
  const invalidDeclarations = validateDeclarations(input.name, isStatus, input.transitions)

  if (Option.isSome(invalidDeclarations)) {
    const invalidDeclarationFailure = Effect.fail(invalidDeclarations.value)

    Effect.runSync(invalidDeclarationFailure)
  }

  const tag = `Invalid${input.name}Transition` as const

  const ErrorSchema = Schema.TaggedError<Readonly<{
    _tag: `Invalid${Name}Transition`
    key: string
    action: string
    actual: string
    message: string
  }>>()(tag, TransitionErrorFields)

  const frozenTransitions = Record.map(input.transitions, freezeDeclaration)
  const assignedTransitions = Struct.assign(input.transitions, frozenTransitions)
  const transitions = Object.freeze(assignedTransitions)
  const actions = Struct.keys(input.transitions)
  const ActionsSchema = Schema.Literals(actions)

  const invalid = (action: string, key: string, actual: string) =>
    ErrorSchema.make({ key, action, actual, message: `${input.name} ${key} cannot ${action} while ${actual}` })

  const allows = (actual: string) => (entry: TransitionDeclaration<Status["Type"]>) =>
    isStatus(actual) && Array.contains(entry.from, actual)

  const guard = <A extends Action>(action: A, key: string, actual: string) => {
    const declaration = transitions[action]

    if (allows(actual)(declaration)) return Effect.succeed(declaration.to)

    const error = invalid(action, key, actual)

    return Effect.fail(error)
  }

  const applyTo = <Row extends Readonly<Record<Field, Status["Type"]>>, A extends Action>(row: Row) =>
    (to: Target<A>) => {
      const update = Record.fromEntries([[input.field, to] as const])

      return Struct.assign(row, update)
    }

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
