import { createHash } from "node:crypto"
import { Array, Effect, Equal, Function, Option, Order, Predicate, Record, Schema, String as Text, Struct, Tuple, flow, pipe } from "effect"
import type { ApplicationIR } from "effect-domains/application"
import { amongst, operationIn, problemIf, repeatedKeys } from "./catalog.ts"
import { AcceptanceError, type Action, CustomTarget, ElementSemantics, type InputCase, LiteralSourceSchema, type Payload, PayloadSchema, RowIdentity, type Scenario, TargetPart } from "./model.ts"

const absent = "undefined"

const entryKey = ([key]: readonly [string, unknown]) => key

/** Orders object entries by key because canonical JSON must not depend on construction order. */
export const byEntryKey = Order.mapInput(Order.String, entryKey)

const canonicalEntry = ([key, value]: readonly [string, unknown]) => {
  const name = JSON.stringify(key)
  const text = canonical(value)

  return `${name}:${text}`
}

const arrayCanonical = (values: ReadonlyArray<unknown>) => {
  const items = pipe(values, Array.map(canonical), Array.join(","))

  return `[${items}]`
}

const objectCanonical = (value: Payload) => {
  const entries = pipe(value, Record.toEntries, Array.sort(byEntryKey), Array.map(canonicalEntry), Array.join(","))

  return `{${entries}}`
}

const scalarCanonical = (value: unknown) => pipe(JSON.stringify(value), Option.fromUndefinedOr, Option.getOrElse(Function.constant(absent)))

/** Key-sorted JSON because payload, binding, and action comparisons must ignore property order. */
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return arrayCanonical(value)

  return Predicate.isObject(value) ? objectCanonical(value) : scalarCanonical(value)
}

export const sameCanonical = (left: unknown) => (right: unknown) => {
  const expected = canonical(left)
  const actual = canonical(right)

  return Equal.equals(expected, actual)
}

/** An element bound by a declared presentation locator and the semantics the application gives it. */
class BoundElement extends Schema.Class<BoundElement>("BoundElement")({
  locator: Schema.NonEmptyString,
  semantics: ElementSemantics,
}) {}

/** A column's native value is JSON in an application attribute because rendered text is presentation and need not round-trip the value. */
export class ColumnBinding extends Schema.Class<ColumnBinding>("ColumnBinding")({
  column: Schema.NonEmptyString,
  locator: Schema.NonEmptyString,
  attribute: Schema.NonEmptyString,
}) {}

const ColumnsSchema = Schema.Array(ColumnBinding)

/** A repeated collection: its row locator, the identity attribute every row action is bound to, and the column that must render the same identity. */
class CollectionBinding extends Schema.Class<CollectionBinding>("CollectionBinding")({
  row: BoundElement,
  identity: Schema.NonEmptyString,
  identityColumn: Schema.NonEmptyString,
  columns: ColumnsSchema,
}) {}

const FieldSourceKindSchema = Schema.Literals(["identity", "column", "literal", "control"])
const OptionalNameSchema = Schema.OptionFromOptionalKey(Schema.NonEmptyString)
const OptionalValueSchema = Schema.OptionFromOptionalKey(Schema.Unknown)

/**
 * Where one operation input field comes from: the bound row identity, a bound column (`name`), a literal implied by the trigger (`value`),
 * or a candidate value entered into a declared control (`name`). Validation rejects a missing or superfluous `name` or `value`.
 */
class FieldBinding extends Schema.Class<FieldBinding>("FieldBinding")({
  from: FieldSourceKindSchema,
  name: OptionalNameSchema,
  value: OptionalValueSchema,
}) {}

const ControlKindSchema = Schema.Literals(["text", "select"])

export class ControlBinding extends Schema.Class<ControlBinding>("ControlBinding")({
  name: Schema.NonEmptyString,
  kind: ControlKindSchema,
  element: BoundElement,
}) {}

const ControlsSchema = Schema.Array(ControlBinding)
const FieldsSchema = Schema.Record(Schema.String, FieldBinding)

/**
 * A row-scoped action: its native operation, row-scoped trigger, controls for candidate fields, the source of every input field,
 * and the page-level selector that matches once the surface has settled on the action's result.
 */
export class ActionBinding extends Schema.Class<ActionBinding>("ActionBinding")({
  id: Schema.NonEmptyString,
  operation: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  trigger: BoundElement,
  controls: ControlsSchema,
  fields: FieldsSchema,
  settle: Schema.NonEmptyString,
}) {}

const ActionBindingsSchema = Schema.Array(ActionBinding)
const NamesSchema = Schema.Array(Schema.NonEmptyString)

/**
 * The explicit binding of one authored custom UI surface because the harness must never infer custom controls with a global selector heuristic.
 * Locators are CSS selectors; row-scoped ones are relative to the bound row. `ready` is the surface's settled-state selector, `source` the
 * operation its rows come from, `scenarios` the scenarios executed through it, and `presentation` the repository files whose changes are
 * presentation-only (accepted only by locator repair, and only while the binding semantics are unchanged).
 */
export class SurfaceBinding extends Schema.Class<SurfaceBinding>("SurfaceBinding")({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
  ready: Schema.NonEmptyString,
  source: Schema.NonEmptyString,
  refresh: BoundElement,
  collection: CollectionBinding,
  actions: ActionBindingsSchema,
  scenarios: NamesSchema,
  presentation: NamesSchema,
}) {}

const SurfaceBindingsSchema = Schema.Array(SurfaceBinding)

export type SurfaceDeclaration = typeof SurfaceBinding.Encoded

class ControlSemantics extends Schema.Class<ControlSemantics>("ControlSemantics")({
  name: Schema.String,
  kind: ControlKindSchema,
  semantics: ElementSemantics,
}) {}

const ControlSemanticsSchema = Schema.Array(ControlSemantics)

class ActionSemantics extends Schema.Class<ActionSemantics>("ActionSemantics")({
  id: Schema.String,
  operation: Schema.String,
  trigger: ElementSemantics,
  controls: ControlSemanticsSchema,
  fields: FieldsSchema,
}) {}

const ActionSemanticsSchema = Schema.Array(ActionSemantics)
const TextsSchema = Schema.Array(Schema.String)

/** A binding without its locators because a presentation-only change may alter locators but never what the surface means. */
class SurfaceSemantics extends Schema.Class<SurfaceSemantics>("SurfaceSemantics")({
  id: Schema.String,
  path: Schema.String,
  source: Schema.String,
  refresh: ElementSemantics,
  row: ElementSemantics,
  identity: Schema.String,
  identityColumn: Schema.String,
  columns: TextsSchema,
  actions: ActionSemanticsSchema,
  scenarios: TextsSchema,
  presentation: TextsSchema,
}) {}

/** Retained with every run because a later repair may only accept presentation changes when the binding semantics are identical. */
export class SurfaceIdentity extends Schema.Class<SurfaceIdentity>("SurfaceIdentity")({
  id: Schema.String,
  semantics: Schema.String,
  presentation: TextsSchema,
}) {}

const surfaceFailure = (boundary: string) => (message: string) => AcceptanceError.make({ boundary, message })

const bindingFailure = surfaceFailure("surface-binding")

const repairRefusal = surfaceFailure("repair")

const describeSchemaFailure = (error: Schema.SchemaError) => bindingFailure(error.message)

const controlSemantics = (control: ControlBinding) => ControlSemantics.make({ name: control.name, kind: control.kind, semantics: control.element.semantics })

const actionSemantics = (action: ActionBinding) => ActionSemantics.make({
  id: action.id,
  operation: action.operation,
  trigger: action.trigger.semantics,
  controls: Array.map(action.controls, controlSemantics),
  fields: action.fields,
})

// A column's meaning is its name and the attribute its value is read from because a changed attribute changes the observed value.
const columnSemantics = (column: ColumnBinding) => `${column.column}@${column.attribute}`

const semanticsOf = (surface: SurfaceBinding) => SurfaceSemantics.make({
  id: surface.id,
  path: surface.path,
  source: surface.source,
  refresh: surface.refresh.semantics,
  row: surface.collection.row.semantics,
  identity: surface.collection.identity,
  identityColumn: surface.collection.identityColumn,
  columns: Array.map(surface.collection.columns, columnSemantics),
  actions: Array.map(surface.actions, actionSemantics),
  scenarios: surface.scenarios,
  presentation: surface.presentation,
})

const digest = (text: string) => createHash("sha256").update(text).digest("hex")

/** Identifies a surface by the digest of its locator-free semantics because repair compares meaning, not presentation. */
export const surfaceIdentity = Effect.fn("Acceptance.surface.identity")(function* (surface: SurfaceBinding) {
  const encoded = yield* pipe(surface, semanticsOf, Schema.encodeEffect(SurfaceSemantics), Effect.mapError(describeSchemaFailure))
  const semantics = pipe(encoded, canonical, digest)

  return SurfaceIdentity.make({ id: surface.id, semantics, presentation: surface.presentation })
})

const sourcedFrom = (kind: FieldBinding["from"]) => (binding: FieldBinding) => Equal.equals(binding.from, kind)

const isIdentityBinding = sourcedFrom("identity")

const isLiteralBinding = sourcedFrom("literal")

const isControlBinding = sourcedFrom("control")

const isColumnBinding = sourcedFrom("column")

const literalValue = (binding: FieldBinding) => {
  const literal = isLiteralBinding(binding)

  return literal ? binding.value : Option.none<unknown>()
}

const identityEntry = ([, binding]: readonly [string, FieldBinding]) => isIdentityBinding(binding)

/** The single input field carrying the row identity; validation guarantees exactly one. */
export const identityFieldOf = (action: ActionBinding) => pipe(action.fields, Record.toEntries, Array.findFirst(identityEntry), Option.map(Tuple.get(0)))

const isLiteralSource = Schema.is(LiteralSourceSchema)

const prefixed = (prefix: string) => (detail: string) => `${prefix}${detail}`

const referencesOf = (kind: FieldBinding["from"]) => (action: ActionBinding) => pipe(action.fields, Record.values, Array.filter(sourcedFrom(kind)), Array.map(Struct.get("name")), Array.getSomes)

const needsName = (binding: FieldBinding) => isColumnBinding(binding) || isControlBinding(binding)

// A binding's name and value must be exactly those its source uses because a stray value would never be submitted.
const sourceProblem = (where: string) => ([field, binding]: readonly [string, FieldBinding]) => {
  const named = Option.isSome(binding.name)
  const valued = Option.isSome(binding.value)
  const nameNeeded = needsName(binding)
  const valueNeeded = isLiteralBinding(binding)
  const nameAgrees = Equal.equals(named, nameNeeded)
  const valueAgrees = Equal.equals(valued, valueNeeded)
  const agrees = nameAgrees && valueAgrees

  return agrees ? Option.none<string>() : Option.some(`${where} field ${field} (${binding.from}) needs exactly the name or value its source uses`)
}

const actionProblems = (surface: SurfaceBinding, application: ApplicationIR) => (action: ActionBinding) => {
  const where = `Surface ${surface.id} action ${action.id}`
  const identities = pipe(action.fields, Record.values, Array.countBy(isIdentityBinding))
  const controls = Array.map(action.controls, Struct.get("name"))
  const columns = Array.map(surface.collection.columns, Struct.get("column"))
  const referencedControls = referencesOf("control")(action)
  const referencedColumns = referencesOf("column")(action)
  const unknownControls = Array.filter(referencedControls, Predicate.not(amongst(controls)))
  const unusedControls = Array.filter(controls, Predicate.not(amongst(referencedControls)))
  const unknownColumns = Array.filter(referencedColumns, Predicate.not(amongst(columns)))
  const reusedControls = repeatedKeys(referencedControls)
  const doubledControls = repeatedKeys(controls)
  const unsourced = pipe(action.fields, Record.toEntries, Array.map(sourceProblem(where)), Array.getSomes)
  const unknownOperation = !operationIn(application)(action.operation)
  const unidentified = !Equal.equals(identities, 1)

  return [
    ...problemIf(unknownOperation, `${where} binds unknown native operation ${action.operation}`),
    ...problemIf(unidentified, `${where} must bind exactly one input field to the row identity`),
    ...Array.map(unknownControls, prefixed(`${where} references undeclared control `)),
    ...Array.map(unusedControls, prefixed(`${where} declares a control no input field uses: `)),
    ...Array.map(reusedControls, prefixed(`${where} binds one control to several fields: `)),
    ...Array.map(doubledControls, prefixed(`${where} declares a control twice: `)),
    ...Array.map(unknownColumns, prefixed(`${where} references undeclared column `)),
    ...unsourced,
  ]
}

const sourceAgrees = (binding: unknown) => (source: InputCase["fields"][string]) => isLiteralSource(source) && sameCanonical(source.value)(binding)

const declaredLiteral = (input: InputCase, field: string) => (value: unknown) => pipe(input.fields, Record.get(field), Option.exists(sourceAgrees(value)))

const literalAgrees = (input: InputCase) => ([field, binding]: readonly [string, FieldBinding]) => {
  const literal = literalValue(binding)

  return Option.match(literal, { onNone: Function.constTrue, onSome: declaredLiteral(input, field) })
}

const actionCovers = (input: InputCase) => (action: ActionBinding) => {
  const sameOperation = Equal.equals(action.operation, input.operation)
  const bound = Record.keys(action.fields)
  const covered = pipe(input.fields, Record.keys, Array.every(amongst(bound)))
  const literals = pipe(action.fields, Record.toEntries, Array.every(literalAgrees(input)))

  return Array.every([sameOperation, covered, literals], Boolean)
}

const declaredAs = (id: string) => (declaration: Readonly<{ id: string }>) => Equal.equals(declaration.id, id)

const inputOf = (scenario: Scenario) => (id: string) => Array.findFirst(scenario.inputs, declaredAs(id))

const uncoveredBy = (surface: SurfaceBinding) => (input: InputCase) => !Array.some(surface.actions, actionCovers(input))

const bindsScenario = (id: string) => (surface: SurfaceBinding) => Array.contains(surface.scenarios, id)

const declaredScenarioProblems = (surface: SurfaceBinding, id: string) => (scenario: Scenario) => {
  const operations = Array.map(surface.actions, Struct.get("operation"))
  const unbound = Array.filter(scenario.operations, Predicate.not(amongst(operations)))
  const required = pipe(scenario.required, Array.map(inputOf(scenario)), Array.getSomes)
  const uncovered = pipe(required, Array.filter(uncoveredBy(surface)), Array.map(Struct.get("id")))

  return [
    ...Array.map(unbound, prefixed(`Surface ${surface.id} binds scenario ${id} but no action executes its operation `)),
    ...Array.map(uncovered, prefixed(`Surface ${surface.id} has no action whose fields and literals cover a required input of ${id}: `)),
  ]
}

const scenarioProblems = (surface: SurfaceBinding, scenarios: ReadonlyArray<Scenario>, surfaces: ReadonlyArray<SurfaceBinding>) => (id: string) => {
  const scenario = Array.findFirst(scenarios, declaredAs(id))
  const binders = Array.countBy(surfaces, bindsScenario(id))
  const unknown = Option.isNone(scenario)
  const shared = binders > 1
  const declared = Option.match(scenario, { onNone: Array.empty<string>, onSome: declaredScenarioProblems(surface, id) })

  return [
    ...problemIf(unknown, `Surface ${surface.id} binds unknown scenario ${id}`),
    ...problemIf(shared, `Scenario ${id} is bound by more than one custom surface`),
    ...declared,
  ]
}

const surfaceProblems = (scenarios: ReadonlyArray<Scenario>, application: ApplicationIR, surfaces: ReadonlyArray<SurfaceBinding>) => (surface: SurfaceBinding) => {
  const ids = Array.map(surfaces, Struct.get("id"))
  const duplicated = Array.countBy(ids, Equal.equals(surface.id)) > 1
  const unrooted = !Text.startsWith("/")(surface.path)
  const root = Equal.equals(surface.path, "/")
  const unpathed = unrooted || root
  const columns = Array.map(surface.collection.columns, Struct.get("column"))
  const actions = Array.map(surface.actions, Struct.get("id"))
  const repeatedColumns = repeatedKeys(columns)
  const repeatedActions = repeatedKeys(actions)
  const unidentified = !Array.contains(columns, surface.collection.identityColumn)
  const unknownSource = !operationIn(application)(surface.source)

  return [
    ...problemIf(duplicated, `Duplicate custom surface id ${surface.id}`),
    ...problemIf(unpathed, `Surface ${surface.id} path ${surface.path} must be a non-root absolute path`),
    ...problemIf(unidentified, `Surface ${surface.id} identity column ${surface.collection.identityColumn} is not a declared column`),
    ...problemIf(unknownSource, `Surface ${surface.id} row source ${surface.source} is not a native operation`),
    ...Array.map(repeatedColumns, prefixed(`Surface ${surface.id} declares a column twice: `)),
    ...Array.map(repeatedActions, prefixed(`Surface ${surface.id} declares an action twice: `)),
    ...Array.flatMap(surface.actions, actionProblems(surface, application)),
    ...Array.flatMap(surface.scenarios, scenarioProblems(surface, scenarios, surfaces)),
  ]
}

/** Decodes and validates the declared surfaces against the executed scenarios and native operations because an unbound or ambiguous custom control must never run. */
export const validateSurfaces = Effect.fn("Acceptance.surface.validate")(function* (declarations: ReadonlyArray<SurfaceDeclaration>, scenarios: ReadonlyArray<Scenario>, application: ApplicationIR) {
  const surfaces = yield* pipe(declarations, Schema.decodeUnknownEffect(SurfaceBindingsSchema), Effect.mapError(describeSchemaFailure))
  const problems = Array.flatMap(surfaces, surfaceProblems(scenarios, application, surfaces))
  const problemList = Array.join(problems, "; ")

  if (Array.isReadonlyArrayNonEmpty(problems)) return yield* bindingFailure(`Invalid custom surface bindings: ${problemList}`)

  return surfaces
})

/** The surface a scenario executes through, if any. */
export const surfaceFor = (surfaces: ReadonlyArray<SurfaceBinding>, scenario: string) => Array.findFirst(surfaces, bindsScenario(scenario))

const submittedAgrees = (submitted: Option.Option<unknown>) => (value: unknown) => Option.exists(submitted, sameCanonical(value))

const literalHolds = (input: Payload) => ([field, binding]: readonly [string, FieldBinding]) => {
  const literal = literalValue(binding)
  const submitted = Record.get(input, field)

  return Option.match(literal, { onNone: Function.constTrue, onSome: submittedAgrees(submitted) })
}

/** A binding action applies to a candidate only when its operation, literals, and field coverage agree, because a trigger implies its literal fields. */
export const appliesTo = (operation: string, input: Payload) => (action: ActionBinding) => {
  const sameOperation = Equal.equals(action.operation, operation)
  const bound = Record.keys(action.fields)
  const covered = pipe(input, Record.keys, Array.every(amongst(bound)))
  const literals = pipe(action.fields, Record.toEntries, Array.every(literalHolds(input)))

  return Array.every([sameOperation, covered, literals], Boolean)
}

/** One scanned row: its identity attribute and its bound columns' decoded values. */
export class SurfaceRow extends Schema.Class<SurfaceRow>("SurfaceRow")({
  identity: Schema.String,
  columns: PayloadSchema,
}) {}

/** A row is consistent only when its identity attribute equals its rendered identity column because a swapped attribute must never retarget an action. */
export const consistentRow = (surface: SurfaceBinding) => (row: SurfaceRow) => pipe(row.columns, Record.get(surface.collection.identityColumn), Option.exists(sameCanonical(row.identity)))

const presentEntry = (field: string) => (value: unknown) => Tuple.make(field, value)

const columnValue = (row: SurfaceRow) => (name: string) => Record.get(row.columns, name)

const identityValue = (row: SurfaceRow, binding: FieldBinding) => isIdentityBinding(binding) ? Option.some<unknown>(row.identity) : Option.none<unknown>()

const columnBound = (row: SurfaceRow, binding: FieldBinding) => {
  const column = isColumnBinding(binding)
  const name = column ? binding.name : Option.none<string>()

  return Option.flatMap(name, columnValue(row))
}

const boundValue = (row: SurfaceRow, binding: FieldBinding) => {
  const identity = identityValue(row, binding)
  const column = columnBound(row, binding)
  const literal = literalValue(binding)

  return Option.firstSomeOf([identity, column, literal])
}

// A field yields none when the row cannot supply it, or some(none) when an empty control leaves an optional field out, because entered values come from the candidate.
const composedEntry = (row: SurfaceRow, input: Payload) => ([field, binding]: readonly [string, FieldBinding]) => {
  const supplied = pipe(input, Record.get(field), Option.map(presentEntry(field)))
  const bound = boundValue(row, binding)
  const fixed = Option.map(bound, flow(presentEntry(field), Option.some))

  return isControlBinding(binding) ? Option.some(supplied) : fixed
}

const presentEntries = (entries: ReadonlyArray<Option.Option<readonly [string, unknown]>>) => pipe(entries, Array.getSomes, Record.fromEntries)

/** Composes the payload a row action submits from the row and the candidate's control values; none when a bound column is missing. */
export const composePayload = (action: ActionBinding, row: SurfaceRow, input: Payload) => pipe(
  action.fields,
  Record.toEntries,
  Array.map(composedEntry(row, input)),
  Option.all,
  Option.map(presentEntries),
)

const controlField = (name: string) => ([, binding]: readonly [string, FieldBinding]) => {
  const control = isControlBinding(binding)
  const named = Option.contains(binding.name, name)

  return control && named
}

const fieldIn = (input: Payload) => ([field]: readonly [string, FieldBinding]) => Record.get(input, field)

const textOf = (value: unknown) => Predicate.isString(value) ? value : JSON.stringify(value)

/** The text a control must hold for a candidate: its bound field's value, or empty when the optional field is absent. */
export const controlText = (action: ActionBinding, input: Payload) => (name: string) => pipe(
  action.fields,
  Record.toEntries,
  Array.findFirst(controlField(name)),
  Option.flatMap(fieldIn(input)),
  Option.map(textOf),
  Option.getOrElse(Function.constant("")),
)

const rowIdentity = (attribute: string) => (field: string) => RowIdentity.make({ attribute, field })

const rowPart = (surface: SurfaceBinding) => TargetPart.make({ part: "row", locator: surface.collection.row.locator, scoped: false, semantics: surface.collection.row.semantics })

const triggerPart = (action: ActionBinding) => TargetPart.make({ part: "trigger", locator: action.trigger.locator, scoped: true, semantics: action.trigger.semantics })

const controlPart = (control: ControlBinding) => TargetPart.make({ part: `control:${control.name}`, locator: control.element.locator, scoped: true, semantics: control.element.semantics })

/** The bound target of a row action: the row, its trigger, and every declared control, each with locator and semantics. */
export const rowTarget = (surface: SurfaceBinding, action: ActionBinding) => {
  const row = pipe(identityFieldOf(action), Option.map(rowIdentity(surface.collection.identity)))
  const controls = Array.map(action.controls, controlPart)
  const head = [rowPart(surface), triggerPart(action)]
  const parts = Array.appendAll(head, controls)

  return CustomTarget.make({ surface: surface.id, action: action.id, row, parts })
}

/** The bound target of re-reading the surface's rows through its own refresh control. */
export const refreshTarget = (surface: SurfaceBinding) => {
  const part = TargetPart.make({ part: "refresh", locator: surface.refresh.locator, scoped: false, semantics: surface.refresh.semantics })

  return CustomTarget.make({ surface: surface.id, action: "rows", row: Option.none(), parts: [part] })
}

/** Opening a surface navigates to its declared path; it binds no element. */
export const openTarget = (surface: SurfaceBinding) => CustomTarget.make({ surface: surface.id, action: "open", row: Option.none(), parts: [] })

const partLocator = (part: TargetPart) => `${part.part}=${part.locator}`

/** The action target names the surface action and every declared locator because a changed locator must make the recorded action unavailable to strict replay. */
export const targetText = (target: CustomTarget, path: string) => {
  const locators = pipe(target.parts, Array.map(partLocator), Array.join(" | "))
  const detail = Array.isReadonlyArrayEmpty(target.parts) ? path : locators

  return `surface:${target.surface}/${target.action} @ ${detail}`
}

class SemanticPart extends Schema.Class<SemanticPart>("SemanticPart")({
  part: Schema.String,
  scoped: Schema.Boolean,
  semantics: ElementSemantics,
}) {}

const SemanticPartsSchema = Schema.Array(SemanticPart)
const OptionalTextSchema = Schema.OptionFromOptionalKey(Schema.String)
const OptionalPayloadSchema = Schema.OptionFromOptionalKey(PayloadSchema)
const OptionalRowSchema = Schema.OptionFromOptionalKey(RowIdentity)

/** Everything a repair must keep: the action identity, its payload, and the semantic target, but none of the locators. */
class SemanticKey extends Schema.Class<SemanticKey>("SemanticKey")({
  id: Schema.String,
  kind: Schema.String,
  operation: OptionalTextSchema,
  inputCase: OptionalTextSchema,
  value: OptionalPayloadSchema,
  surface: Schema.String,
  action: Schema.String,
  row: OptionalRowSchema,
  parts: SemanticPartsSchema,
}) {}

const semanticPart = (part: TargetPart) => SemanticPart.make({ part: part.part, scoped: part.scoped, semantics: part.semantics })

const notCustom = repairRefusal("Only actions offered through a declared custom-UI binding may have their locators repaired")

const keyOf = (action: Action) => (target: CustomTarget) => SemanticKey.make({
  id: action.id,
  kind: action.kind,
  operation: action.operation,
  inputCase: action.inputCase,
  value: action.value,
  surface: target.surface,
  action: target.action,
  row: target.row,
  parts: Array.map(target.parts, semanticPart),
})

const semanticKey = Effect.fn("Acceptance.surface.semanticKey")(function* (action: Action) {
  const target = yield* pipe(action.binding, Effect.fromOption, Effect.mapError(Function.constant(notCustom)))
  const encoded = yield* pipe(target, keyOf(action), Schema.encodeEffect(SemanticKey), Effect.mapError(describeSchemaFailure))

  return canonical(encoded)
})

const noParts = Array.empty<TargetPart>()

const locatorsOf = (action: Action) => pipe(action.binding, Option.map(Struct.get("parts")), Option.getOrElse(Function.constant(noParts)), Array.map(partLocator), Array.join(" | "))

const keyedOption = Effect.fn("Acceptance.surface.keyedOption")(function* (option: Action) {
  const key = yield* semanticKey(option)

  return Tuple.make(key, option)
})

const isCustom = (action: Action) => Option.isSome(action.binding)

const keyIs = (expected: string) => ([key]: readonly [string, Action]) => Equal.equals(key, expected)

/**
 * Finds the single currently offered action with the recorded action's exact semantic target (surface, action, operation, input case,
 * bound row identity and payload, roles, accessible names, attributes) but different locators. The recorded action must already carry
 * the rebound candidate payload because fixtures issue fresh identities. None, several, or unchanged locators refuse the repair.
 */
export const repairMatch = Effect.fn("Acceptance.surface.repairMatch")(function* (recorded: Action, options: ReadonlyArray<Action>) {
  const expected = yield* semanticKey(recorded)
  const keyed = yield* pipe(options, Array.filter(isCustom), Effect.forEach(keyedOption))
  const matches = pipe(keyed, Array.filter(keyIs(expected)), Array.map(Tuple.get(1)))
  const count = Array.length(matches)
  const none = Equal.equals(count, 0)
  const several = count > 1

  if (none) return yield* repairRefusal(`No currently offered action has the recorded semantic target of ${recorded.id} (surface, operation, input case, row identity, role, accessible name, attributes, and payload); a semantic mismatch is never repaired`)

  if (several) return yield* repairRefusal(`${count} offered actions share the recorded semantic target of ${recorded.id}; an ambiguous repair is refused`)

  const match = yield* pipe(matches, Array.head, Effect.fromOption, Effect.mapError(Function.constant(notCustom)))
  const original = locatorsOf(recorded)
  const current = locatorsOf(match)
  const unchanged = Equal.equals(original, current)

  if (unchanged) return yield* repairRefusal(`The declared locators of ${recorded.id} are unchanged, so its unavailability is not a locator failure`)

  return match
})
