import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { Array, DateTime, Effect, Equal, FiberSet, Function, HashMap, Layer, Option, Order, Predicate, Record, Redacted, Ref, Result, Schema, String as Text, Struct, Tuple, flow, pipe } from "effect"
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request, type Response, type Route } from "playwright"
import { AcceptanceError, Action, BrowserSurface, Candidate, CustomTarget, type ElementSemantics, Exchange, LocatorCheck, LocatorRepair, Observation, Offer, PayloadSchema, RequestGate, type RowIdentity, Submission, TargetPart, type Payload } from "./model.ts"
import { type ActionBinding, ColumnBinding, type ControlBinding, SurfaceBinding, SurfaceRow, appliesTo, byEntryKey, canonical, composePayload, consistentRow, controlText, identityFieldOf, openTarget, refreshTarget, rowTarget, sameCanonical, targetText } from "./surface.ts"

const timeout = 7_000
// Submissions wait longer than navigation because a native operation may legitimately complete its work before it answers.
const submissionTimeout = 60_000
const absent = "undefined"
const maximumActions = 48
const listSuffix = ".list"
const localHosts = ["localhost", "127.0.0.1", "[::1]"]
const structuredTags = ["TEXTAREA", "SELECT"]
const navigationKinds = ["open", "observe"]
const navigationButtons = ".admin-nav button[data-operation]"
const tokenInput = "input.admin-token"
const navigationAlert = ".admin-content > [role='alert']"
const navigationReady = ".admin-content table[data-loaded='true'], .admin-content form.admin-form button[data-action='submit']:not(:disabled), .admin-content [role='alert']"
const submissionReady = ".admin-content table[data-loaded='true'], .admin-operation-result pre.admin-result, .admin-operation-result [role='alert']"

const OptionalSurfaceSchema = Schema.Option(SurfaceBinding)

/** The scenario's custom surface travels with the target because only the runner knows which explicit binding a scenario executes through. */
export class BrowserTarget extends Schema.Class<BrowserTarget>("BrowserTarget")({ url: Schema.String, artifacts: Schema.String, surface: OptionalSurfaceSchema }) {}

class PublicCall extends Schema.Class<PublicCall>("PublicCall")({ operation: Schema.String, input: PayloadSchema }) {}

const PublicCallJsonSchema = Schema.fromJsonString(PublicCall)
const PayloadJsonSchema = Schema.fromJsonString(PayloadSchema)
const UnknownJsonSchema = Schema.fromJsonString(Schema.Unknown)
const PayloadsSchema = Schema.Array(PayloadSchema)
const TextsSchema = Schema.Array(Schema.String)
const NextCursorSchema = Schema.OptionFromOptionalKey(Schema.NullOr(Schema.String))

class ListPage extends Schema.Class<ListPage>("ListPage")({ items: PayloadsSchema, nextCursor: NextCursorSchema }) {}

class ListEvidence extends Schema.Class<ListEvidence>("ListEvidence")({ operation: Schema.String, input: PayloadSchema, result: ListPage }) {}

const OptionalListEvidenceSchema = Schema.Option(ListEvidence)

class ListTracking extends Schema.Class<ListTracking>("ListTracking")({ sequence: Schema.Int, evidence: OptionalListEvidenceSchema }) {}

class NavigationEntry extends Schema.Class<NavigationEntry>("NavigationEntry")({
  operation: Schema.String,
  target: Schema.String,
  label: Schema.String,
  visible: Schema.Boolean,
  enabled: Schema.Boolean,
}) {}

class Inclusion extends Schema.Class<Inclusion>("Inclusion")({ path: Schema.String, checked: Schema.Boolean, enabled: Schema.Boolean, visible: Schema.Boolean }) {}

const InclusionJsonSchema = Schema.fromJsonString(Inclusion)
const InclusionsSchema = Schema.Array(InclusionJsonSchema)

class Control extends Schema.Class<Control>("Control")({
  path: Schema.String,
  tag: Schema.String,
  type: Schema.String,
  value: Schema.String,
  checked: Schema.Boolean,
  visible: Schema.Boolean,
  enabled: Schema.Boolean,
  inclusions: InclusionsSchema,
}) {}

const ControlJsonSchema = Schema.fromJsonString(Control)
const ControlsSchema = Schema.Array(ControlJsonSchema)

const AttributesSchema = Schema.Array(Schema.String)

/** The submit target's attributes are part of the form because an offered snapshot must go stale when its target changes. */
class Form extends Schema.Class<Form>("Form")({
  operation: Schema.String,
  controls: ControlsSchema,
  submitVisible: Schema.Boolean,
  submitEnabled: Schema.Boolean,
  submitAttributes: AttributesSchema,
  fallback: Schema.String,
}) {}

class Cell extends Schema.Class<Cell>("Cell")({ column: Schema.String, value: Schema.String, text: Schema.String }) {}

const CellJsonSchema = Schema.fromJsonString(Cell)
const CellsSchema = Schema.Array(CellJsonSchema)

class Row extends Schema.Class<Row>("Row")({ identity: Schema.String, cells: CellsSchema }) {}

const RowJsonSchema = Schema.fromJsonString(Row)
const RowsSchema = Schema.Array(RowJsonSchema)

class Table extends Schema.Class<Table>("Table")({
  operation: Schema.String,
  resource: Schema.String,
  identifier: Schema.String,
  loaded: Schema.Boolean,
  unfiltered: Schema.Boolean,
  complete: Schema.Boolean,
  input: Schema.String,
  rows: RowsSchema,
}) {}

/** `shown` is the result region's rendered text because qualitative review judges exactly what the user saw, including refusal alerts. */
class OperationResult extends Schema.Class<OperationResult>("OperationResult")({ success: Schema.Boolean, text: Schema.String, alert: Schema.Boolean, shown: Schema.String }) {}

const NavigationJsonSchema = Schema.fromJsonString(NavigationEntry)
const NavigationSchema = Schema.Array(NavigationJsonSchema)
const FormJsonSchema = Schema.fromJsonString(Form)
const OptionalFormSchema = Schema.OptionFromNullOr(FormJsonSchema)
const TableJsonSchema = Schema.fromJsonString(Table)
const OptionalTableSchema = Schema.OptionFromNullOr(TableJsonSchema)
const OperationResultJsonSchema = Schema.fromJsonString(OperationResult)
const OptionalOperationResultSchema = Schema.OptionFromNullOr(OperationResultJsonSchema)
const NoticesSchema = Schema.Array(Schema.Boolean)

class Rendered extends Schema.Class<Rendered>("Rendered")({
  url: Schema.String,
  navigation: NavigationSchema,
  form: OptionalFormSchema,
  table: OptionalTableSchema,
  result: OptionalOperationResultSchema,
  loadingNotices: NoticesSchema,
}) {}

const RenderedJsonSchema = Schema.fromJsonString(Rendered)

class Listing extends Schema.Class<Listing>("Listing")({
  operation: Schema.String,
  resource: Schema.String,
  loaded: Schema.Boolean,
  unfiltered: Schema.Boolean,
  complete: Schema.Boolean,
  rows: PayloadsSchema,
}) {}

class RowScan extends Schema.Class<RowScan>("RowScan")({ rows: PayloadsSchema, identities: TextsSchema, intact: Schema.Boolean }) {}

const OptionalCandidateSchema = Schema.Option(Candidate)

class Offered extends Schema.Class<Offered>("Offered")({ action: Action, offer: Offer, candidate: OptionalCandidateSchema }) {}

class ElementState extends Schema.Class<ElementState>("ElementState")({ count: Schema.Int, visible: Schema.Boolean, enabled: Schema.Boolean }) {}

const ElementStateJsonSchema = Schema.fromJsonString(ElementState)
const OptionValuesSchema = Schema.Array(Schema.String)

class ControlState extends Schema.Class<ControlState>("ControlState")({
  name: Schema.String,
  count: Schema.Int,
  visible: Schema.Boolean,
  enabled: Schema.Boolean,
  options: OptionValuesSchema,
}) {}

const ControlStateJsonSchema = Schema.fromJsonString(ControlState)
const ControlStatesSchema = Schema.Array(ControlStateJsonSchema)

class RowActionState extends Schema.Class<RowActionState>("RowActionState")({ id: Schema.String, trigger: ElementStateJsonSchema, controls: ControlStatesSchema }) {}

const CellValueSchema = Schema.NullOr(Schema.String)

class ScannedCell extends Schema.Class<ScannedCell>("ScannedCell")({ column: Schema.String, value: CellValueSchema }) {}

const ScannedCellJsonSchema = Schema.fromJsonString(ScannedCell)
const RowActionStateJsonSchema = Schema.fromJsonString(RowActionState)
const ScannedCellsSchema = Schema.Array(ScannedCellJsonSchema)
const RowActionStatesSchema = Schema.Array(RowActionStateJsonSchema)

class ScannedRow extends Schema.Class<ScannedRow>("ScannedRow")({ identity: Schema.String, cells: ScannedCellsSchema, actions: RowActionStatesSchema }) {}

const ScannedRowJsonSchema = Schema.fromJsonString(ScannedRow)
const ScannedRowsSchema = Schema.Array(ScannedRowJsonSchema)

/** The custom surface as rendered: where the page is, whether it settled, its refresh control, and every bound row with its controls' states. */
class SurfaceScan extends Schema.Class<SurfaceScan>("SurfaceScan")({ path: Schema.String, ready: Schema.Boolean, refresh: ElementStateJsonSchema, rows: ScannedRowsSchema }) {}

const SurfaceScanJsonSchema = Schema.fromJsonString(SurfaceScan)

class ProbeControl extends Schema.Class<ProbeControl>("ProbeControl")({ name: Schema.String, locator: Schema.String }) {}

const ProbeControlsSchema = Schema.Array(ProbeControl)

class ProbeAction extends Schema.Class<ProbeAction>("ProbeAction")({ id: Schema.String, trigger: Schema.String, controls: ProbeControlsSchema }) {}

const ProbeColumnsSchema = Schema.Array(ColumnBinding)
const ProbeActionsSchema = Schema.Array(ProbeAction)

/** Only the declared locators cross into the page because the binding's semantics are judged in this process. */
class SurfaceProbe extends Schema.Class<SurfaceProbe>("SurfaceProbe")({
  ready: Schema.String,
  row: Schema.String,
  identity: Schema.String,
  columns: ProbeColumnsSchema,
  refresh: Schema.String,
  actions: ProbeActionsSchema,
}) {}

type ProbeDeclaration = typeof SurfaceProbe.Encoded

class SurfaceTurn extends Schema.Class<SurfaceTurn>("SurfaceTurn")({ binding: SurfaceBinding, scan: SurfaceScan }) {}

const OptionalSurfaceTurnSchema = Schema.Option(SurfaceTurn)

class Turn extends Schema.Class<Turn>("Turn")({ offer: Offer, current: Rendered, listed: Listing, surface: OptionalSurfaceTurnSchema, snapshot: Schema.String }) {}

const HarnessFailureSchema = Schema.Struct({ _tag: Schema.String, message: Schema.String, response: Schema.Unknown })

interface HarnessFailure extends Schema.Schema.Type<typeof HarnessFailureSchema> {}

// The capture runs inside Chromium because Playwright serializes it into the page; records cross that boundary as JSON text decoded by the schemas above.
const captureRendered = () => {
  const visible = (node: HTMLElement | null) => {
    const rendered = node?.checkVisibility() ?? false
    const rectangles = node?.getClientRects()
    const boxed = (rectangles?.length ?? 0) > 0

    return rendered && boxed
  }

  const enabled = (node: HTMLElement | null) => {
    const disabled = node?.matches(":disabled, [aria-disabled='true']") ?? true

    return !disabled
  }

  const navigationEntry = (node: HTMLButtonElement) => {
    const operation = node.dataset.operation ?? ""
    const operationTarget = node.classList.contains("admin-nav-operation")
    const target = operationTarget ? "operation" : "resource"
    const label = node.textContent ?? ""
    const shown = visible(node)
    const usable = enabled(node)

    return JSON.stringify({ operation, target, label, visible: shown, enabled: usable })
  }

  const inclusionEntry = (inclusion: HTMLInputElement) => {
    const path = inclusion.dataset.inclusionPath ?? ""
    const shown = visible(inclusion)
    const usable = enabled(inclusion)

    return JSON.stringify({ path, checked: inclusion.checked, enabled: usable, visible: shown })
  }

  const ancestorInclusions = (form: HTMLFormElement, ancestor: HTMLElement | null): Array<string> => {
    if (!ancestor) return []

    return ancestor.isSameNode(form) ? [] : ownedInclusions(form, ancestor)
  }

  const ownedInclusions = (form: HTMLFormElement, ancestor: HTMLElement) => {
    const inclusion = ancestor.querySelector<HTMLInputElement>(":scope > .admin-optional > input[data-inclusion-path]")
    const outer = ancestorInclusions(form, ancestor.parentElement)

    return inclusion ? [inclusionEntry(inclusion), ...outer] : outer
  }

  const controlEntry = (form: HTMLFormElement) => (control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
    const input = control instanceof HTMLInputElement
    const path = control.dataset.inputPath ?? ""
    const type = input ? control.type : ""
    const checked = input && control.checked
    const shown = visible(control)
    const usable = enabled(control)
    const inclusions = ancestorInclusions(form, control.parentElement)

    return JSON.stringify({ path, tag: control.tagName, type, value: control.value, checked, visible: shown, enabled: usable, inclusions })
  }

  const attributeEntry = (attribute: Attr) => `${attribute.name}=${attribute.value}`

  const formEntry = (form: HTMLFormElement) => {
    const operation = form.dataset.operation ?? ""
    const submit = form.querySelector<HTMLButtonElement>("button[data-action='submit']")
    const fallback = form.querySelector<HTMLTextAreaElement>(".admin-json-fallback textarea")
    const nodes = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-input-path]")
    const controls = globalThis.Array.from(nodes, controlEntry(form))
    const submitVisible = visible(submit)
    const submitEnabled = enabled(submit)
    const submitAttributes = submit ? globalThis.Array.from(submit.attributes, attributeEntry) : []
    const fallbackText = fallback?.value ?? ""

    return JSON.stringify({ operation, controls, submitVisible, submitEnabled, submitAttributes, fallback: fallbackText })
  }

  const cellEntry = (cell: HTMLTableCellElement) => {
    const column = cell.dataset.column ?? ""
    const value = cell.dataset.value ?? ""
    const text = cell.textContent ?? ""

    return JSON.stringify({ column, value, text })
  }

  const rowEntry = (row: HTMLTableRowElement) => {
    const identity = row.dataset.rowIdentity ?? ""
    const nodes = row.querySelectorAll<HTMLTableCellElement>("td[data-column]")
    const cells = globalThis.Array.from(nodes, cellEntry)

    return JSON.stringify({ identity, cells })
  }

  const tableEntry = (table: HTMLTableElement) => {
    const operation = table.dataset.operation ?? ""
    const resource = table.dataset.resource ?? ""
    const identifier = table.dataset.identifier ?? ""
    const loaded = table.matches("[data-loaded='true'] > [data-loaded='true']")
    const unfiltered = table.matches("[data-unfiltered='true']")
    const complete = table.matches("[data-complete='true']")
    const input = table.dataset.requestInput ?? ""
    const nodes = table.querySelectorAll<HTMLTableRowElement>("tbody > tr")
    const rows = globalThis.Array.from(nodes, rowEntry)

    return JSON.stringify({ operation, resource, identifier, loaded, unfiltered, complete, input, rows })
  }

  const resultEntry = (node: HTMLElement) => {
    const notice = node.querySelector<HTMLElement>(".admin-notice-success")
    const output = node.querySelector<HTMLElement>("pre.admin-result")
    const alert = node.querySelector<HTMLElement>("[role='alert']")
    const success = visible(notice)
    const text = output?.textContent ?? ""
    const alerted = Boolean(alert)

    return JSON.stringify({ success, text, alert: alerted, shown: node.innerText })
  }

  const navigationNodes = document.querySelectorAll<HTMLButtonElement>(".admin-nav button[data-operation]")
  const formNode = document.querySelector<HTMLFormElement>(".admin-content form.admin-form[data-operation]")
  const tableNode = document.querySelector<HTMLTableElement>(".admin-content table[data-resource]")
  const resultNode = document.querySelector<HTMLElement>(".admin-content .admin-operation-result")
  const noticeNodes = document.querySelectorAll<HTMLElement>(".admin-content .admin-notice-loading")
  const navigation = globalThis.Array.from(navigationNodes, navigationEntry)
  const form = formNode ? formEntry(formNode) : null
  const tableShown = visible(tableNode)
  const table = tableShown && tableNode ? tableEntry(tableNode) : null
  const result = resultNode ? resultEntry(resultNode) : null
  const loadingNotices = globalThis.Array.from(noticeNodes, visible)

  return JSON.stringify({ url: location.href, navigation, form, table, result, loadingNotices })
}

// The surface scan runs inside Chromium because only the page can resolve the declared locators; it returns raw attribute text as nested JSON.
const captureSurface = (probe: ProbeDeclaration) => {
  const visible = (node: Element | null) => {
    const element = node instanceof HTMLElement ? node : null
    const rendered = element?.checkVisibility() ?? false
    const rectangles = element?.getClientRects()
    const boxed = (rectangles?.length ?? 0) > 0

    return rendered && boxed
  }

  const enabled = (node: Element | null) => {
    const disabled = node?.matches(":disabled, [aria-disabled='true']") ?? true

    return !disabled
  }

  const stateOf = (nodes: NodeListOf<Element>) => {
    const first = nodes.item(0)
    const shown = visible(first)
    const usable = enabled(first)

    return JSON.stringify({ count: nodes.length, visible: shown, enabled: usable })
  }

  const optionValue = (option: HTMLOptionElement) => option.getAttribute("value") ?? option.text

  const controlEntry = (row: Element) => (control: ProbeDeclaration["actions"][number]["controls"][number]) => {
    const nodes = row.querySelectorAll(control.locator)
    const first = nodes.item(0)
    const shown = visible(first)
    const usable = enabled(first)
    const options = first instanceof HTMLSelectElement ? globalThis.Array.from(first.options, optionValue) : []

    return JSON.stringify({ name: control.name, count: nodes.length, visible: shown, enabled: usable, options })
  }

  const actionEntry = (row: Element) => (action: ProbeDeclaration["actions"][number]) => {
    const triggers = row.querySelectorAll(action.trigger)
    const trigger = stateOf(triggers)
    const controls = globalThis.Array.from(action.controls, controlEntry(row))

    return JSON.stringify({ id: action.id, trigger, controls })
  }

  const cellEntry = (row: Element) => (column: ProbeDeclaration["columns"][number]) => {
    const cell = row.querySelector(column.locator)
    const value = cell?.getAttribute(column.attribute) ?? null

    return JSON.stringify({ column: column.column, value })
  }

  const rowEntry = (row: Element) => {
    const identity = row.getAttribute(probe.identity) ?? ""
    const cells = globalThis.Array.from(probe.columns, cellEntry(row))
    const actions = globalThis.Array.from(probe.actions, actionEntry(row))

    return JSON.stringify({ identity, cells, actions })
  }

  const readyNode = document.querySelector(probe.ready)
  const refreshNodes = document.querySelectorAll(probe.refresh)
  const rowNodes = document.querySelectorAll(probe.row)
  const ready = Boolean(readyNode)
  const refresh = stateOf(refreshNodes)
  const rows = globalThis.Array.from(rowNodes, rowEntry)

  return JSON.stringify({ path: location.pathname, ready, refresh, rows })
}

const loadingCleared = () => !document.querySelector(".admin-notice-loading")

const settledOn = (ready: string) => {
  const loading = document.querySelector(".admin-content .admin-notice-loading")
  const settled = document.querySelector(ready)
  const quiet = !loading

  return quiet && Boolean(settled)
}

const messageOf = (cause: unknown) => Predicate.isError(cause) ? cause.message : String(cause)

const failure = (boundary: string) => (cause: unknown) => AcceptanceError.make({ boundary, message: messageOf(cause) })

const invalidTarget = (cause: unknown) => AcceptanceError.make({ boundary: "browser.open", message: String(cause) })

const rebound = (boundary: string) => (error: AcceptanceError) => AcceptanceError.make({ boundary, message: error.message })

const runtimeError = (message: string) => AcceptanceError.make({ boundary: "runtime", message })

const isolationRequired = AcceptanceError.make({ boundary: "browser.open", message: "AcceptanceError: Browser acceptance requires an isolated localhost HTTP application" })
const tokenRefused = AcceptanceError.make({ boundary: "browser.authenticate", message: "The generated UI did not accept the bearer token entry" })
const leftOrigin = runtimeError("Browser left the isolated application origin")
const unavailableTarget = runtimeError("The semantic target is missing, ambiguous, hidden, or disabled")
const unlistedOperation = runtimeError("Captured observations require a public <resource>.list operation")
const escapedArtifacts = runtimeError("Screenshot must be a file within the scenario artifact directory")
const oversizedCatalog = runtimeError("Rendered action catalog exceeds the bounded generated-UI surface")
const alteredAction = runtimeError("Unknown, altered, or already consumed browser action")
const staleSnapshot = runtimeError("Stale browser snapshot; obtain fresh rendered actions")
const modelCannotProceed = runtimeError("The decision model explicitly cannot proceed")
const outsideOffer = runtimeError("Navigation is outside the offered operations and observations")
const reloadUnavailable = runtimeError("Reload is not offered for this scenario")
const inactiveForm = runtimeError("The requested generated operation form is no longer active")
const unapprovedPayload = runtimeError("Payload differs from the approved candidate or operation identity")
const nonBooleanCheckbox = runtimeError("Checkbox candidate is not a boolean")
const unrepresentable = runtimeError("Generated field cannot represent this candidate")
const unretainedControl = runtimeError("Generated control did not retain the exact proposed value or operation")
const incompleteSubmission = runtimeError("Submission fields are incomplete or changed")
const deadlineExceeded = runtimeError("Public response body exceeded the browser deadline")
const exceeded = Effect.fail(deadlineExceeded)
const noActions: ReadonlyArray<Action> = []
const noOperations: ReadonlyArray<string> = []
const noCandidates: ReadonlyArray<Candidate> = []
const noOffers = HashMap.empty<string, Offered>()
const noLists = HashMap.empty<string, ListTracking>()
const noResult = Option.none<unknown>()
const noCandidate = Option.none<Candidate>()
const initialTracking = ListTracking.make({ sequence: 0, evidence: Option.none() })
const unlisted = Listing.make({ operation: "", resource: "", loaded: false, unfiltered: false, complete: false, rows: [] })
const initialScan = RowScan.make({ rows: [], identities: [], intact: true })

const blank = (text: string) => {
  const trimmed = text.trim()

  return Equal.equals(trimmed, "")
}

const unescapeSegment = (segment: string) => segment.replaceAll("~1", "/").replaceAll("~0", "~")

const escapeKey = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1")

const elementEntry = (item: unknown, position: number) => {
  const key = String(position)

  return Tuple.make(key, item)
}

const ownProperty = (segment: string) => (value: unknown) => {
  if (Array.isArray(value)) return pipe(value, Array.map(elementEntry), Record.fromEntries, Record.get(segment))

  return Predicate.isObject(value) ? Record.get(value, segment) : Option.none()
}

const descend = (current: Option.Option<unknown>, segment: string) => Option.flatMap(current, ownProperty(segment))

const atPath = (input: Payload, path: string) => {
  const segments = pipe(path.slice(1).split("/"), Array.map(unescapeSegment))
  const root = Option.some<unknown>(input)

  return Array.reduce(segments, root, descend)
}

const parsedValue = Schema.decodeUnknownOption(UnknownJsonSchema)

const parsedCanonical = flow(parsedValue, Option.map(canonical))

const numberCanonical = (text: string) => {
  const number = Number(text)

  return blank(text) ? absent : canonical(number)
}

const textCanonical = (control: Control) => Equal.equals(control.type, "number") ? numberCanonical(control.value) : canonical(control.value)

const scalarControlCanonical = (control: Control) => Equal.equals(control.type, "checkbox") ? canonical(control.checked) : textCanonical(control)

const controlCanonical = (control: Control) => {
  const structured = Array.contains(structuredTags, control.tag)
  const scalar = scalarControlCanonical(control)

  return structured ? parsedCanonical(control.value) : Option.some(scalar)
}

const agrees = (control: Control) => (value: unknown) => {
  const expected = canonical(value)
  const actual = controlCanonical(control)

  return Option.contains(actual, expected)
}

const matches = (input: Payload) => (control: Control) => {
  const included = Array.every(control.inclusions, Struct.get("checked"))
  const proposed = atPath(input, control.path)

  return included ? Option.exists(proposed, agrees(control)) : Option.isNone(proposed)
}

const isListOperation = (operation: string) => operation.endsWith(listSuffix)

const operationIs = (operation: string) => (subject: Pick<Form, "operation">) => Equal.equals(subject.operation, operation)

const listedCall = (call: PublicCall) => isListOperation(call.operation)

const atControlPath = (path: string) => (control: Control) => Equal.equals(control.path, path)

const controlAt = (path: string) => (form: Form) => Array.findFirst(form.controls, atControlPath(path))

const activeForm = (operation: string) => (form: Form) => {
  const requested = Equal.equals(form.operation, operation)

  return requested && blank(form.fallback)
}

const loading = (current: Rendered) => Array.some(current.loadingNotices, Boolean)

const decodeCall = (request: Request) => pipe(request.postData(), Option.fromNullOr, Option.flatMap(Schema.decodeUnknownOption(PublicCallJsonSchema)))

const decodeRequest = (request: Request) => pipe(request.postData(), Schema.decodeUnknownEffect(PublicCallJsonSchema))

const publicCallOf = (origin: string) => (response: Response) => {
  const address = response.url()
  const url = new URL(address)
  const request = response.request()
  const method = request.method()
  const local = Equal.equals(url.origin, origin)
  const endpoint = url.pathname.endsWith("/api/call")
  const posted = Equal.equals(method, "POST")

  return Array.every([local, endpoint, posted], Boolean)
}

const operationCallOf = (origin: string, operation: string) => (response: Response) => {
  const request = response.request()
  const call = decodeCall(request)
  const publicCall = publicCallOf(origin)(response)
  const requested = pipe(call, Option.map(Struct.get("operation")), Option.contains(operation))

  return publicCall && requested
}

const callEndpoint = (address: URL) => address.pathname.endsWith("/api/call")

const requestsOperation = (operation: string) => (request: Request) => {
  const method = request.method()
  const posted = Equal.equals(method, "POST")
  const requested = pipe(request, decodeCall, Option.map(Struct.get("operation")), Option.contains(operation))

  return posted && requested
}

// Route steps only log their failure because the held click still observes the response or its absence and reports that as the submission outcome.
const logRouteFailure = (cause: unknown) => Effect.logWarning("A held submission route step failed", cause)

const settleRoute = (step: "abort" | "continue") => Effect.fn("BrowserSurface.settleRoute")(function* (route: Route) {
  yield* Effect.tryPromise({ try: () => route[step](), catch: Function.identity })
}, Effect.catch(logRouteFailure))

const abortRoute = settleRoute("abort")

const continueRoute = settleRoute("continue")

// A held request continues only when its gate releases and is aborted when the gate fails, because a broken barrier must not let one competitor run alone.
const releaseRoute = (route: Route) => (held: Effect.Effect<void, AcceptanceError>) => {
  const aborted = abortRoute(route)
  const continued = continueRoute(route)

  return Effect.matchEffect(held, { onFailure: Function.constant(aborted), onSuccess: Function.constant(continued) })
}

const holdRoute = (matches: (request: Request) => boolean, held: Effect.Effect<void, AcceptanceError>) => (route: Route) => {
  const request = route.request()
  const released = releaseRoute(route)(held)

  return matches(request) ? Effect.runPromise(released) : route.fallback()
}

const listCallOf = (origin: string) => (response: Response) => {
  const publicCall = publicCallOf(origin)(response)
  const ok = response.ok()
  const eligible = publicCall && ok
  const request = response.request()
  const listed = pipe(request, decodeCall, Option.filter(listedCall))

  return eligible ? listed : Option.none()
}

const responseBody = (response: Response) => Effect.tryPromise({ try: () => response.json(), catch: Function.identity })

const decodePayload = Schema.decodeUnknownEffect(PayloadSchema)

const decodeEnvelope = (response: Response) => pipe(
  responseBody(response),
  Effect.timeoutOrElse({ duration: timeout, orElse: Function.constant(exceeded) }),
  Effect.flatMap(decodePayload),
)

const listEvidenceOf = Effect.fn("BrowserSurface.listEvidence")(function* (response: Response, call: PublicCall) {
  const body = yield* decodeEnvelope(response)
  const result = yield* pipe(body, Record.get("result"), Option.getOrUndefined, Schema.decodeUnknownEffect(ListPage))

  return ListEvidence.make({ operation: call.operation, input: call.input, result })
})

const next = (value: number) => value + 1

const advanceSequence = (tracking: ListTracking) => {
  const sequence = next(tracking.sequence)
  const advanced = ListTracking.make({ sequence, evidence: tracking.evidence })

  return Tuple.make(sequence, advanced)
}

const trackingAt = (operation: string) => flow(HashMap.get(operation), Option.getOrElse(Function.constant(initialTracking)))

const advanceAt = (operation: string) => (tracked: HashMap.HashMap<string, ListTracking>) => {
  const current = trackingAt(operation)(tracked)
  const [sequence, advanced] = advanceSequence(current)
  const updated = HashMap.set(tracked, operation, advanced)

  return Tuple.make(sequence, updated)
}

const evidenceTracked = (sequence: number) => (evidence: ListEvidence) => ListTracking.make({ sequence, evidence: Option.some(evidence) })

const settleTracking = (sequence: number, outcome: Result.Result<ListEvidence, unknown>) => (tracking: ListTracking) => {
  if (!Equal.equals(tracking.sequence, sequence)) return tracking

  const cleared = ListTracking.make({ sequence, evidence: Option.none() })

  return Result.match(outcome, { onFailure: Function.constant(cleared), onSuccess: evidenceTracked(sequence) })
}

const settleAt = (operation: string, sequence: number, outcome: Result.Result<ListEvidence, unknown>) => HashMap.modify<string, ListTracking>(operation, settleTracking(sequence, outcome))

const forget = (tracking: ListTracking) => ListTracking.make({ sequence: tracking.sequence, evidence: Option.none() })

const renderedText = (value: unknown) => Predicate.isString(value) ? value : JSON.stringify(value, null, 2)

const columnEntry = (column: string) => (value: unknown) => Tuple.make(column, value)

const cellEntry = (cell: Cell) => pipe(
  cell.value,
  parsedValue,
  Option.filter(flow(renderedText, Equal.equals(cell.text))),
  Option.map(columnEntry(cell.column)),
)

const identityOf = (identifier: string) => (payload: Payload) => pipe(payload, Record.get(identifier), Option.match({ onNone: Function.constant(absent), onSome: canonical }))

const decodeRow = (identifier: string) => (row: Row) => {
  const columns = Array.map(row.cells, Struct.get("column"))
  const named = Array.every(columns, Predicate.isTruthy)
  const unique = Array.dedupe(columns)
  const distinct = Equal.equals(unique.length, columns.length)
  const identity = pipe(row.identity, Option.liftPredicate(Predicate.isTruthy), Option.flatMap(parsedCanonical))
  const payload = pipe(row.cells, Array.map(cellEntry), Option.all, Option.map(Record.fromEntries))
  const rendered = Option.map(payload, identityOf(identifier))
  const present = Option.isSome(identity)
  const identified = present && Equal.equals(identity, rendered)
  const valid = Array.every([named, distinct, identified], Boolean)

  return valid ? payload : Option.none()
}

const halt = (scan: RowScan) => RowScan.make({ rows: scan.rows, identities: scan.identities, intact: false })

const extend = (scan: RowScan, identity: string) => (payload: Payload) => RowScan.make({
  rows: Array.append(scan.rows, payload),
  identities: Array.append(scan.identities, identity),
  intact: true,
})

const scanRow = (identifier: string) => (scan: RowScan, row: Row) => {
  if (!scan.intact) return scan

  const duplicate = Array.contains(scan.identities, row.identity)
  const halted = halt(scan)

  if (duplicate) return halted

  const decoded = decodeRow(identifier)(row)

  return Option.match(decoded, { onNone: Function.constant(halted), onSome: extend(scan, row.identity) })
}

const rowIn = (rows: ReadonlyArray<Payload>) => (item: Payload) => Array.some(rows, sameCanonical(item))

const lastPage = (page: ListPage) => pipe(page.nextCursor, Option.flatMap(Option.fromNullOr), Option.isNone)

const completes = (table: Table, input: Payload, rows: ReadonlyArray<Payload>) => (evidence: ListEvidence) => {
  const operation = Equal.equals(evidence.operation, table.operation)
  const request = sameCanonical(evidence.input)(input)
  const final = lastPage(evidence.result)
  const counted = Equal.equals(evidence.result.items.length, rows.length)
  const covered = Array.every(evidence.result.items, rowIn(rows))

  return Array.every([operation, request, final, counted, covered], Boolean)
}

const requestListing = (table: Table, rows: ReadonlyArray<Payload>, evidence: Option.Option<ListEvidence>, busy: boolean) => (input: Payload) => {
  const filtered = Record.has(input, "filter")
  const paged = Record.has(input, "cursor")
  const unfiltered = Array.every([table.unfiltered, !filtered, !paged], Boolean)
  const completed = Option.exists(evidence, completes(table, input, rows))
  const complete = table.complete && completed
  const idle = !busy
  const loaded = Array.every([table.loaded, idle, unfiltered, complete], Boolean)

  return Listing.make({ operation: table.operation, resource: table.resource, loaded, unfiltered, complete, rows })
}

const tableListing = (tracked: HashMap.HashMap<string, ListTracking>, busy: boolean) => (table: Table) => {
  const tracking = trackingAt(table.operation)(tracked)
  const scan = Array.reduce(table.rows, initialScan, scanRow(table.identifier))
  const broken = Listing.make({ operation: table.operation, resource: table.resource, loaded: false, unfiltered: false, complete: false, rows: scan.rows })

  if (!scan.intact) return broken

  const input = Schema.decodeUnknownOption(PayloadJsonSchema)(table.input)

  return Option.match(input, { onNone: Function.constant(broken), onSome: requestListing(table, scan.rows, tracking.evidence, busy) })
}

const isListedTable = (table: Table) => {
  const listed = Equal.equals(table.operation, `${table.resource}${listSuffix}`)
  const named = Predicate.isTruthy(table.resource)
  const identified = Predicate.isTruthy(table.identifier)

  return Array.every([listed, named, identified], Boolean)
}

const listingOf = (current: Rendered, tracked: HashMap.HashMap<string, ListTracking>) => {
  const busy = loading(current)

  return pipe(current.table, Option.filter(isListedTable), Option.match({ onNone: Function.constant(unlisted), onSome: tableListing(tracked, busy) }))
}

const isOperationTarget = (entry: NavigationEntry) => Equal.equals(entry.target, "operation")

const usableEntry = (entry: NavigationEntry) => entry.visible && entry.enabled

const preferredEntry = (entries: ReadonlyArray<NavigationEntry>) => (operation: string) => {
  const same = Array.filter(entries, operationIs(operation))
  const targeted = pipe(same, Array.filter(isOperationTarget), Array.last)
  const first = Array.head(same)

  return Option.orElse(targeted, Function.constant(first))
}

const formShown = (current: Rendered) => (operation: string) => Option.exists(current.form, operationIs(operation))

const listShown = (listed: Listing) => (operation: string) => {
  const same = Equal.equals(listed.operation, operation)

  return listed.loaded && same
}

const openAction = (snapshot: string) => (entry: NavigationEntry) => Action.make({
  id: `open:${entry.operation}`,
  description: `Open the ${entry.label} form (${entry.operation}) to enter an input for it`,
  kind: "open",
  operation: Option.some(entry.operation),
  inputCase: Option.none(),
  value: Option.none(),
  target: `navigation:${entry.operation}:${entry.target}`,
  binding: Option.none(),
  snapshot,
})

const observeAction = (snapshot: string) => (entry: NavigationEntry) => Action.make({
  id: `observe:${entry.operation}`,
  description: `Open the complete, unfiltered ${entry.label} list (${entry.operation}) to observe all of its current records`,
  kind: "observe",
  operation: Option.some(entry.operation),
  inputCase: Option.none(),
  value: Option.none(),
  target: `navigation:${entry.operation}:${entry.target}`,
  binding: Option.none(),
  snapshot,
})

// A surface-bound scenario executes its operations only through its explicit binding because the generated form would bypass the surface under test.
const navigationActions = (turn: Turn) => {
  const entries = Array.filter(turn.current.navigation, usableEntry)
  const preferred = preferredEntry(entries)
  const operations = Option.isSome(turn.surface) ? noOperations : turn.offer.operations

  const opens = pipe(
    operations,
    Array.dedupe,
    Array.filter(Predicate.not(formShown(turn.current))),
    Array.map(preferred),
    Array.getSomes,
    Array.map(openAction(turn.snapshot)),
  )

  const observes = pipe(
    turn.offer.observations,
    Array.dedupe,
    Array.filter(isListOperation),
    Array.filter(Predicate.not(listShown(turn.listed))),
    Array.map(preferred),
    Array.getSomes,
    Array.map(observeAction(turn.snapshot)),
  )

  return Array.appendAll(opens, observes)
}

const childPointer = (pointer: string) => ([key, value]: readonly [string, unknown]) => {
  const escaped = escapeKey(key)

  return Tuple.make(`${pointer}/${escaped}`, value)
}

const objectChildren = (pointer: string, value: Payload) => pipe(value, Record.toEntries, Array.map(childPointer(pointer)))

const memberEntries = (pointer: string, value: unknown): ReadonlyArray<readonly [string, unknown]> => {
  if (Array.isArray(value)) return pipe(value, Array.map(elementEntry), Array.map(childPointer(pointer)))

  return Predicate.isObject(value) ? objectChildren(pointer, value) : []
}

const isContainer = (value: unknown) => Array.isArray(value) || Predicate.isObject(value)

// A container value needs a structured control because enter serializes it as JSON only for TEXTAREA and SELECT controls; scalar inputs would render it as unrelated text.
const representsAt = (pointer: string, value: unknown) => (control: Control) => {
  const located = Equal.equals(control.path, pointer)
  const structured = Array.contains(structuredTags, control.tag)
  const scalar = !isContainer(value)
  const encodable = structured || scalar

  return located && encodable
}

// A candidate value is covered by an exact control that can encode it or, for a non-empty container, by covering every member, because otherwise the generated form would silently drop or never produce that value.
const coversValue = (form: Form) => ([pointer, value]: readonly [string, unknown]): boolean => {
  const exact = Array.some(form.controls, representsAt(pointer, value))
  const children = memberEntries(pointer, value)
  const populated = Array.isReadonlyArrayNonEmpty(children)
  const members = Array.every(children, coversValue(form))
  const nested = populated && members

  return exact || nested
}

const coversInput = (form: Form) => (input: Payload) => pipe(objectChildren("", input), Array.every(coversValue(form)))

const includable = (inclusion: Inclusion) => inclusion.enabled && inclusion.visible

const unavailableControl = (input: Payload) => (control: Control) => {
  const proposed = atPath(input, control.path)
  const togglable = Array.every(control.inclusions, includable)
  const missing = Option.isNone(proposed)
  const uncontrolled = Array.isReadonlyArrayEmpty(control.inclusions)
  const unincludable = missing && uncontrolled

  return Array.some([!control.visible, !control.enabled, !togglable, unincludable], Boolean)
}

const fieldSummary = ([key, value]: readonly [string, unknown]) => {
  const text = canonical(value)

  return `${key}=${text}`
}

const summaryOf = (input: Payload) => pipe(input, Record.toEntries, Array.sort(byEntryKey), Array.map(fieldSummary), Array.join(", "))

const formActions = (candidate: Candidate, snapshot: string) => (form: Form) => {
  const outstanding = Array.filter(form.controls, Predicate.not(matches(candidate.input)))
  const unavailable = Array.filter(outstanding, unavailableControl(candidate.input))
  const covered = coversInput(form)(candidate.input)
  const ready = covered && Array.isReadonlyArrayEmpty(unavailable)
  const fillable = ready && Array.isReadonlyArrayNonEmpty(outstanding)
  const matched = Array.isReadonlyArrayEmpty(outstanding)
  const submittable = Array.every([covered, matched, form.submitVisible, form.submitEnabled], Boolean)
  const summary = summaryOf(candidate.input)

  const fill = Action.make({
    id: `fill:${candidate.inputCase}`,
    description: `${candidate.description} (${summary}); enter exactly these values into the generated ${candidate.operation} controls without submitting`,
    kind: "fill",
    operation: Option.some(candidate.operation),
    inputCase: Option.some(candidate.inputCase),
    value: Option.some(candidate.input),
    target: `payload:${candidate.inputCase}`,
    binding: Option.none(),
    snapshot,
  })

  const submit = Action.make({
    id: `submit:${candidate.inputCase}`,
    description: `Submit ${candidate.operation} with the entered ${candidate.inputCase} input (${summary}); capture the real public HTTP response`,
    kind: "submit",
    operation: Option.some(candidate.operation),
    inputCase: Option.some(candidate.inputCase),
    value: Option.some(candidate.input),
    target: `submit:${candidate.inputCase}`,
    binding: Option.none(),
    snapshot,
  })

  const fills = fillable ? [fill] : noActions
  const submits = submittable ? [submit] : noActions

  return Array.appendAll(fills, submits)
}

const candidateActions = (turn: Turn) => (candidate: Candidate) => pipe(
  turn.current.form,
  Option.filter(activeForm(candidate.operation)),
  Option.match({ onNone: Function.constant(noActions), onSome: formActions(candidate, turn.snapshot) }),
)

const reloadAction = (snapshot: string) => Action.make({
  id: "reload:page",
  description: "Reload this page from the server and observe what remains visible",
  kind: "reload",
  operation: Option.none(),
  inputCase: Option.none(),
  value: Option.none(),
  target: "page",
  binding: Option.none(),
  snapshot,
})

const cannotProceed = (snapshot: string) => Action.make({
  id: "cannot-proceed",
  description: "Cannot proceed: no safe available interaction advances the requested goal",
  kind: "cannot-proceed",
  operation: Option.none(),
  inputCase: Option.none(),
  value: Option.none(),
  target: "scenario",
  binding: Option.none(),
  snapshot,
})

const surfaceOpenAction = (surface: SurfaceBinding, snapshot: string) => {
  const target = openTarget(surface)

  return Action.make({
    id: `surface:${surface.id}:open`,
    description: `Open the ${surface.title} (${surface.path}), the application's authored page for this work`,
    kind: "open",
    operation: Option.none(),
    inputCase: Option.none(),
    value: Option.none(),
    target: targetText(target, surface.path),
    binding: Option.some(target),
    snapshot,
  })
}

const surfaceRowsAction = (surface: SurfaceBinding, snapshot: string) => {
  const target = refreshTarget(surface)

  return Action.make({
    id: `surface:${surface.id}:rows`,
    description: `Refresh the ${surface.title} rows (${surface.source}) to observe its current records`,
    kind: "observe",
    operation: Option.some(surface.source),
    inputCase: Option.none(),
    value: Option.none(),
    target: targetText(target, surface.path),
    binding: Option.some(target),
    snapshot,
  })
}

const usableState = (state: Pick<ElementState, "count" | "visible" | "enabled">) => {
  const single = Equal.equals(state.count, 1)

  return Array.every([single, state.visible, state.enabled], Boolean)
}

const cellValue = (cell: ScannedCell) => pipe(cell.value, Option.fromNullOr, Option.flatMap(parsedValue), Option.map(columnEntry(cell.column)))

const surfaceRow = (scanned: ScannedRow) => pipe(
  scanned.cells,
  Array.map(cellValue),
  Option.all,
  Option.map(Record.fromEntries),
  Option.map(rowWithColumns(scanned.identity)),
)

const rowWithColumns = (identity: string) => (columns: Payload) => SurfaceRow.make({ identity, columns })

const scannedWith = (identity: string) => (row: ScannedRow) => Equal.equals(row.identity, identity)

const identifiedAs = (id: string) => (item: Readonly<{ id: string }>) => Equal.equals(item.id, id)

const actionStateOf = (id: string) => (row: ScannedRow) => Array.findFirst(row.actions, identifiedAs(id))

const controlReady = (action: ActionBinding, input: Payload) => (control: ControlState) => {
  const expected = controlText(action, input)(control.name)
  const selectable = Array.isReadonlyArrayEmpty(control.options) || Array.contains(control.options, expected)

  return usableState(control) && selectable
}

const actionReady = (action: ActionBinding, input: Payload) => (state: RowActionState) => {
  const trigger = usableState(state.trigger)
  const controls = Array.every(state.controls, controlReady(action, input))
  const declared = Equal.equals(state.controls.length, action.controls.length)

  return Array.every([trigger, controls, declared], Boolean)
}

const candidateIdentity = (action: ActionBinding, input: Payload) => pipe(identityFieldOf(action), Option.flatMap(fieldOfInput(input)), Option.filter(Predicate.isString))

const fieldOfInput = (input: Payload) => (field: string) => Record.get(input, field)

/** The single scanned row bound to the candidate's identity, never a position; none when absent or duplicated. */
const boundRow = (scan: SurfaceScan) => (identity: string) => {
  const rows = Array.filter(scan.rows, scannedWith(identity))
  const single = Equal.equals(rows.length, 1)

  return single ? Array.head(rows) : Option.none<ScannedRow>()
}

// A row action is offered only when its row identity, rendered identity column, composed payload, and every bound control agree exactly with the candidate, because any drift may mean a different target.
const rowActionReady = (turn: SurfaceTurn, action: ActionBinding, candidate: Candidate) => (scanned: ScannedRow) => {
  const row = surfaceRow(scanned)
  const consistent = Option.exists(row, consistentRow(turn.binding))
  const composed = Option.flatMap(row, composeFor(action, candidate.input))
  const exact = Option.exists(composed, sameCanonical(candidate.input))
  const ready = pipe(scanned, actionStateOf(action.id), Option.exists(actionReady(action, candidate.input)))

  return Array.every([consistent, exact, ready], Boolean)
}

const composeFor = (action: ActionBinding, input: Payload) => (row: SurfaceRow) => composePayload(action, row, input)

const surfaceRowAction = (turn: SurfaceTurn, candidate: Candidate, snapshot: string) => (action: ActionBinding) => {
  const target = rowTarget(turn.binding, action)
  const summary = summaryOf(candidate.input)
  const identity = candidateIdentity(action, candidate.input)
  const scanned = Option.flatMap(identity, boundRow(turn.scan))
  const ready = Option.exists(scanned, rowActionReady(turn, action, candidate))

  const offered = Action.make({
    id: `surface:${turn.binding.id}:${action.id}:${candidate.inputCase}`,
    description: `On the ${turn.binding.title}: ${action.description}. ${candidate.description} (${summary}); acts only on the row bound to this identity and captures the real public HTTP response`,
    kind: "submit",
    operation: Option.some(candidate.operation),
    inputCase: Option.some(candidate.inputCase),
    value: Option.some(candidate.input),
    target: targetText(target, turn.binding.path),
    binding: Option.some(target),
    snapshot,
  })

  return ready ? Option.some(offered) : Option.none<Action>()
}

const candidateRowActions = (turn: SurfaceTurn, snapshot: string) => (candidate: Candidate) => pipe(
  turn.binding.actions,
  Array.filter(appliesTo(candidate.operation, candidate.input)),
  Array.map(surfaceRowAction(turn, candidate, snapshot)),
  Array.getSomes,
)

const onSurface = (turn: SurfaceTurn) => Equal.equals(turn.scan.path, turn.binding.path)

const boundActions = (candidates: ReadonlyArray<Candidate>, snapshot: string) => (turn: SurfaceTurn) => {
  const present = onSurface(turn)
  const settled = present && turn.scan.ready
  const refreshable = settled && usableState(turn.scan.refresh)
  const open = present ? noActions : [surfaceOpenAction(turn.binding, snapshot)]
  const rows = refreshable ? [surfaceRowsAction(turn.binding, snapshot)] : noActions
  const operations = settled ? Array.flatMap(candidates, candidateRowActions(turn, snapshot)) : noActions

  return Array.flatten([open, rows, operations])
}

const surfaceActions = (turn: Turn) => Option.match(turn.surface, { onNone: Function.constant(noActions), onSome: boundActions(turn.offer.candidates, turn.snapshot) })

// A surface listing never claims completeness because the custom page does not prove it shows every record.
const surfaceListing = (turn: SurfaceTurn) => {
  const rows = pipe(turn.scan.rows, Array.map(surfaceRow), Array.getSomes, Array.map(Struct.get("columns")))

  return Listing.make({ operation: turn.binding.source, resource: `surface:${turn.binding.id}`, loaded: turn.scan.ready, unfiltered: true, complete: false, rows })
}

const interactiveActions = (turn: Turn) => {
  const navigation = navigationActions(turn)
  const generated = Option.isSome(turn.surface) ? noCandidates : turn.offer.candidates
  const forms = Array.flatMap(generated, candidateActions(turn))
  const custom = surfaceActions(turn)
  const reload = turn.offer.reload ? [reloadAction(turn.snapshot)] : noActions

  return Array.flatten([navigation, forms, custom, reload])
}

const offeredActions = (turn: Turn) => {
  const interactive = loading(turn.current) ? noActions : interactiveActions(turn)
  const proceed = cannotProceed(turn.snapshot)

  return Array.append(interactive, proceed)
}

const sameCase = (inputCase: Option.Option<string>) => (candidate: Candidate) => Option.contains(inputCase, candidate.inputCase)

const offeredEntry = (offer: Offer) => (action: Action) => {
  const candidate = Array.findFirst(offer.candidates, sameCase(action.inputCase))
  const bound = Option.isSome(action.inputCase) ? candidate : noCandidate
  const offered = Offered.make({ action, offer, candidate: bound })

  return Tuple.make(action.id, offered)
}

const encodeAction = flow(Schema.encodeEffect(Action), Effect.map(canonical), Effect.mapError(failure("runtime")))

const attributeSelector = (attribute: string, value: string) => {
  const quoted = JSON.stringify(value)

  return `[${attribute}=${quoted}]`
}

const navigationSelector = (operationTarget: boolean, operation: string) => {
  const target = operationTarget ? ".admin-nav-operation" : ".admin-nav-resource"
  const selector = attributeSelector("data-operation", operation)

  return `.admin-nav ${target}${selector}`
}

const formSelector = (operation: string) => {
  const selector = attributeSelector("data-operation", operation)

  return `.admin-content form.admin-form${selector}`
}

const formReady = (operation: string) => {
  const form = formSelector(operation)

  return `${form} button[data-action='submit'], ${navigationAlert}`
}

const listReady = (operation: string) => {
  const selector = attributeSelector("data-operation", operation)

  return `.admin-content table${selector}[data-loaded='true'], ${navigationAlert}`
}

const offeredScope = (offer: Offer, observing: boolean) => (operation: string) => {
  const lists = Array.filter(offer.observations, isListOperation)
  const scope = observing ? lists : offer.operations

  return Array.contains(scope, operation)
}

const required = <A>(value: Option.Option<A>, error: AcceptanceError) => pipe(value, Effect.fromOption, Effect.mapError(Function.constant(error)))

const resultOf = (body: Payload) => pipe(body, Record.get("result"), Option.flatMap(Option.fromUndefinedOr))

const bodyError = (body: Payload) => pipe(body, Record.get("error"), Option.flatMap(Option.fromNullishOr))

const harnessFailure = (tag: string, message: string, response: Option.Option<unknown>) => HarnessFailureSchema.make({ _tag: tag, message, response: Option.getOrNull(response) })

const undecodedResponse = (cause: unknown) => {
  const detail = messageOf(cause)
  const reported = harnessFailure("UndecodedResponse", `Public response was not a decoded JSON envelope: ${detail}`, noResult)

  return Option.some<unknown>(reported)
}

const unsettledInterface = (error: Option.Option<unknown>) => (cause: unknown) => {
  const detail = messageOf(cause)
  const reported = harnessFailure("UnsettledInterface", `The generated UI did not settle on an operation result after the captured response: ${detail}`, error)

  return Option.some<unknown>(reported)
}

const submittedMismatch = (error: Option.Option<unknown>) => pipe(
  harnessFailure("SubmittedInputMismatch", "The input the generated UI actually submitted differs from the approved candidate", error),
  Option.some<unknown>,
)

const digestOf = (counter: number, text: string) => {
  const material = canonical([counter, text])

  return createHash("sha256").update(material).digest("hex")
}

const decodeRendered = Schema.decodeUnknownEffect(RenderedJsonSchema)

const encodeRendered = Schema.encodeEffect(RenderedJsonSchema)

const decodeSurfaceScan = Schema.decodeUnknownEffect(SurfaceScanJsonSchema)

const encodeSurfaceScan = Schema.encodeEffect(SurfaceScanJsonSchema)

const probeControl = (control: ControlBinding) => ProbeControl.make({ name: control.name, locator: control.element.locator })

const probeAction = (action: ActionBinding) => ProbeAction.make({ id: action.id, trigger: action.trigger.locator, controls: Array.map(action.controls, probeControl) })

const probeOf = (surface: SurfaceBinding) => SurfaceProbe.make({
  ready: surface.ready,
  row: surface.collection.row.locator,
  identity: surface.collection.identity,
  columns: surface.collection.columns,
  refresh: surface.refresh.locator,
  actions: Array.map(surface.actions, probeAction),
})

const encodeProbe = Schema.encodeEffect(SurfaceProbe)

const attributeEntrySelector = ([attribute, value]: readonly [string, string]) => attributeSelector(attribute, value)

const attributesSelector = (attributes: Readonly<Record<string, string>>) => pipe(attributes, Record.toEntries, Array.sort(byEntryKey), Array.map(attributeEntrySelector), Array.join(""))

const nameText = (name: string) => {
  const quoted = JSON.stringify(name)

  return `[name=${quoted}]`
}

/** Describes a semantic target as role, exact accessible name, and attributes because repair provenance must name what was matched. */
const semanticText = (semantics: ElementSemantics, extra: Readonly<Record<string, string>>) => {
  const attributes = Record.union(semantics.attributes, extra, Function.identity)
  const named = pipe(semantics.name, Option.map(nameText), Option.getOrElse(Function.constant("")))
  const selector = attributesSelector(attributes)

  return `role=${semantics.role}${named}${selector}`
}

const isRowPart = (part: TargetPart) => Equal.equals(part.part, "row")

const identityOfAction = (action: Action) => (row: RowIdentity) => pipe(action.value, Option.flatMap(Record.get(row.field)), Option.filter(Predicate.isString))

const boundIdentity = (action: Action, target: CustomTarget) => Option.flatMap(target.row, identityOfAction(action))

const noAttributes = Record.empty<string, string>()

const identityAttribute = ([row, value]: readonly [RowIdentity, string]) => Record.singleton(row.attribute, value)

const identityAttributes = (target: CustomTarget, identity: Option.Option<string>) => pipe(
  Option.all([target.row, identity]),
  Option.map(identityAttribute),
  Option.getOrElse(Function.constant(noAttributes)),
)

const failedPart = (check: LocatorCheck) => !Equal.equals(check.recordedMatches, 1)

const repairedPart = (check: LocatorCheck) => {
  const current = Equal.equals(check.currentMatches, 1)
  const semantic = Equal.equals(check.semanticMatches, 1)

  return Array.every([current, semantic, check.sameElement], Boolean)
}

const describeCheck = (check: LocatorCheck) => `${check.part}: recorded ${check.recorded} matched ${check.recordedMatches}; current ${check.current} matched ${check.currentMatches}; semantic ${check.semantic} matched ${check.semanticMatches}${check.sameElement ? " (same element as the current binding)" : ""}`

const describeRecorded = (check: LocatorCheck) => `${check.part} ${check.recorded} matches ${check.recordedMatches} element(s)`

const repairFailure = (message: string) => AcceptanceError.make({ boundary: "repair", message })

const notRepairable = repairFailure("Only custom-binding actions with declared locators can be diagnosed or repaired")

const wrongRow = runtimeError("The bound row's identity, rendered identity column, payload, or controls no longer match the approved candidate; refusing a possibly wrong target")

const semanticMismatch = runtimeError("The bound element no longer has its declared role, accessible name, or application attributes")

const unboundSurface = runtimeError("The action names a custom surface this scenario is not bound to")

const asRepairFailure = (error: AcceptanceError) => repairFailure(error.message)

const anyName: NonNullable<Parameters<Page["getByRole"]>[1]> = {}

const exactName = (name: string): NonNullable<Parameters<Page["getByRole"]>[1]> => ({ name, exact: true })

/** Resolves an element by role, exact accessible name, and application attributes only, never by presentation. */
const semanticLocator = (page: Page, semantics: ElementSemantics, extra: Readonly<Record<string, string>>) => (scope: Page | Locator) => {
  const options = Option.match(semantics.name, { onNone: Function.constant(anyName), onSome: exactName })
  const byRole = scope.getByRole(semantics.role, options)
  const attributes = Record.union(semantics.attributes, extra, Function.identity)
  const selector = attributesSelector(attributes)
  const unattributed = Equal.equals(selector, "")
  const attributed = page.locator(selector)

  return unattributed ? byRole : byRole.and(attributed)
}

const isLocator = (input: unknown): input is Locator => Predicate.hasProperty(input, "and")

const LocatorSchema = Schema.declare(isLocator)

/** One bound part on the live page: its declared and semantic locators and their descriptions, because checks must compare and name both. */
class LocatedPart extends Schema.Class<LocatedPart>("LocatedPart")({
  part: TargetPart,
  declaredText: Schema.String,
  semanticText: Schema.String,
  declared: LocatorSchema,
  semantic: LocatorSchema,
}) {}

const rowScoped = (rowText: string) => (text: string) => `${rowText} >> ${text}`

/** The declared selector of a part: row-scoped parts are CSS descendants of the identity-filtered row, the row itself carries the identity filter. */
const declaredSelector = (rowSelector: string, identitySelector: string) => (part: TargetPart) => {
  if (part.scoped) return `${rowSelector} ${part.locator}`

  return isRowPart(part) ? `${part.locator}${identitySelector}` : part.locator
}

const partExtra = (extra: Readonly<Record<string, string>>) => (part: TargetPart) => isRowPart(part) ? extra : noAttributes

const AttributeValuesSchema = Schema.Record(Schema.String, Schema.String)

/** The identity-filtered row a row-scoped part resolves within, with its semantic description. */
class RowScope extends Schema.Class<RowScope>("RowScope")({
  selector: Schema.String,
  semanticText: Schema.String,
  extra: AttributeValuesSchema,
}) {}

const OptionalLocatorSchema = Schema.Option(LocatorSchema)

class SemanticRow extends Schema.Class<SemanticRow>("SemanticRow")({ locator: OptionalLocatorSchema }) {}

const locatePart = (page: Page, scope: RowScope, row: SemanticRow) => (part: TargetPart) => {
  const { extra } = scope
  const identitySelector = attributesSelector(extra)
  const selector = declaredSelector(scope.selector, identitySelector)(part)
  const own = partExtra(extra)(part)
  const scoped = part.scoped ? row.locator : Option.none<Locator>()
  const root = Option.getOrElse(scoped, Function.constant<Page | Locator>(page))
  const semantic = semanticLocator(page, part.semantics, own)(root)
  const ownText = semanticText(part.semantics, own)
  const description = part.scoped ? rowScoped(scope.semanticText)(ownText) : ownText
  const declared = page.locator(selector)

  return LocatedPart.make({ part, declaredText: selector, semanticText: description, declared, semantic })
}

const withSuffix = (suffix: string) => (text: string) => `${text}${suffix}`

const rowSemanticOf = (page: Page, extra: Readonly<Record<string, string>>) => (part: TargetPart) => semanticLocator(page, part.semantics, extra)(page)

const rowSemanticTextOf = (extra: Readonly<Record<string, string>>) => (part: TargetPart) => semanticText(part.semantics, extra)

/** Every part's declared locator scoped to the bound row identity, plus its semantic locator, because checks must compare both on the live page. */
const locatorsFor = (page: Page) => (target: CustomTarget, identity: Option.Option<string>) => {
  const extra = identityAttributes(target, identity)
  const identitySelector = attributesSelector(extra)
  const rowPart = Array.findFirst(target.parts, isRowPart)
  const selector = pipe(rowPart, Option.map(Struct.get("locator")), Option.map(withSuffix(identitySelector)), Option.getOrElse(Function.constant("")))
  const locator = Option.map(rowPart, rowSemanticOf(page, extra))
  const description = pipe(rowPart, Option.map(rowSemanticTextOf(extra)), Option.getOrElse(Function.constant("")))
  const scope = RowScope.make({ selector, semanticText: description, extra })
  const row = SemanticRow.make({ locator })

  return Array.map(target.parts, locatePart(page, scope, row))
}

const describeCount = ([located, matches]: readonly [LocatedPart, number]) => `${located.part.part} ${located.declaredText} matches ${matches} element(s)`

const controlNamed = (name: string) => (control: ControlBinding) => Equal.equals(`control:${control.name}`, name)

const controlOfPart = (action: ActionBinding) => (part: TargetPart) => Array.findFirst(action.controls, controlNamed(part.part))

const actionBindingOf = (surface: SurfaceBinding, target: CustomTarget) => Array.findFirst(surface.actions, identifiedAs(target.action))

const partNamed = (name: string) => (located: LocatedPart) => Equal.equals(located.part.part, name)

const isControlPart = (located: LocatedPart) => located.part.part.startsWith("control:")

const surfaceNamed = (id: string) => (turn: SurfaceTurn) => Equal.equals(turn.binding.id, id)

const now = Effect.map(DateTime.now, DateTime.formatIso)

const isoAt = (millis: number) => pipe(DateTime.make(millis), Option.map(DateTime.formatIso))

const nonNegative = Order.max(Order.Number)(0)

/** The request's own sent and received instants from the browser's resource timing because overlapping races are judged by when each request was in flight; absent timing stays absent. */
const exchangeOf = (request: Request) => {
  const timing = request.timing()
  const finished = timing.responseEnd >= 0
  const requested = nonNegative(timing.requestStart)
  const sent = isoAt(timing.startTime + requested)
  const received = finished ? isoAt(timing.startTime + timing.responseEnd) : Option.none<string>()
  const both = Option.all([sent, received])
  const exchange = ([sentAt, receivedAt]: readonly [string, string]) => Exchange.make({ sentAt, receivedAt })

  return Option.map(both, exchange)
}

const closeBrowser = (browser: Browser) => Effect.promise(() => browser.close())

const closeContext = (context: BrowserContext) => Effect.promise(() => context.close())

const makeSurface = Effect.fn("BrowserSurface.make")(function* (target: BrowserTarget) {
  const url = yield* Effect.try({ try: () => new URL(target.url), catch: invalidTarget })
  const http = Equal.equals(url.protocol, "http:")
  const local = Array.contains(localHosts, url.hostname)
  const isolated = http && local

  if (!isolated) return yield* isolationRequired

  const artifacts = resolve(target.artifacts)

  yield* Effect.tryPromise({ try: () => mkdir(artifacts, { recursive: true }), catch: failure("browser.artifacts") })

  const launch = Effect.tryPromise({ try: () => chromium.launch({ timeout }), catch: failure("browser.launch") })
  const browser = yield* Effect.acquireRelease(launch, closeBrowser)
  const open = Effect.tryPromise({ try: () => browser.newContext({ viewport: { width: 1280, height: 900 } }), catch: failure("browser.context") })
  const context = yield* Effect.acquireRelease(open, closeContext)
  const page = yield* Effect.tryPromise({ try: () => context.newPage(), catch: failure("browser.page") })

  page.setDefaultTimeout(timeout)
  page.setDefaultNavigationTimeout(timeout)

  const epoch = yield* Ref.make(0)
  const pageReloaded = yield* Ref.make(false)
  const lists = yield* Ref.make(noLists)
  const offers = yield* Ref.make(noOffers)
  const responses = yield* FiberSet.make<void>()
  const runResponse = yield* FiberSet.runtime(responses)()
  const listCall = listCallOf(url.origin)

  const recordResponse = Effect.fn("BrowserSurface.recordResponse")(function* (response: Response) {
    const call = listCall(response)

    if (Option.isNone(call)) return

    const sequence = yield* Ref.modify(lists, advanceAt(call.value.operation))
    const outcome = yield* pipe(listEvidenceOf(response, call.value), Effect.result)

    yield* Ref.update(lists, settleAt(call.value.operation, sequence, outcome))
  })

  page.on("response", (response) => pipe(response, recordResponse, runResponse))

  const waitUntilSettled = (ready: string) => Effect.tryPromise({ try: () => page.waitForFunction(settledOn, ready, { timeout }), catch: Function.identity })
  const settled = (ready: string) => pipe(ready, waitUntilSettled, Effect.mapError(failure("runtime")))

  const started = Effect.fn("BrowserSurface.started")(function* (boundary: string) {
    yield* Effect.tryPromise({ try: () => page.locator(navigationButtons).first().waitFor({ state: "visible" }), catch: failure(boundary) })
    yield* Effect.tryPromise({ try: () => page.waitForFunction(loadingCleared, null, { timeout }), catch: failure(boundary) })
    yield* pipe(navigationReady, waitUntilSettled, Effect.mapError(failure(boundary)))
  })

  yield* Effect.tryPromise({ try: () => page.goto(target.url, { waitUntil: "domcontentloaded" }), catch: failure("browser.open") })
  yield* started("browser.open")

  const state = Effect.fn("BrowserSurface.state")(function* () {
    yield* FiberSet.awaitEmpty(responses)

    const text = yield* Effect.tryPromise({ try: () => page.evaluate(captureRendered), catch: failure("runtime") })

    return yield* pipe(text, decodeRendered, Effect.mapError(failure("runtime")))
  })

  const surfaceScan = Effect.fn("BrowserSurface.surfaceScan")(function* (surface: SurfaceBinding) {
    const probe = yield* pipe(surface, probeOf, encodeProbe, Effect.mapError(failure("runtime")))
    const text = yield* Effect.tryPromise({ try: () => page.evaluate(captureSurface, probe), catch: failure("runtime") })
    const scan = yield* pipe(text, decodeSurfaceScan, Effect.mapError(failure("runtime")))

    return SurfaceTurn.make({ binding: surface, scan })
  })

  const surfaceState = () => pipe(target.surface, Option.map(surfaceScan), Effect.transposeOption)
  const scanText = (surface: Option.Option<SurfaceTurn>) => pipe(surface, Option.map(flow(Struct.get("scan"), encodeSurfaceScan)), Effect.transposeOption, Effect.map(Option.getOrElse(Function.constant(""))), Effect.mapError(failure("runtime")))

  // The snapshot covers the bound surface too because a changed custom row or control must make offered actions stale.
  const snapshot = Effect.fn("BrowserSurface.snapshot")(function* (current: Rendered, surface: Option.Option<SurfaceTurn>) {
    const counter = yield* Ref.get(epoch)
    const text = yield* pipe(current, encodeRendered, Effect.mapError(failure("runtime")))
    const custom = yield* scanText(surface)

    return digestOf(counter, `${text}\n${custom}`)
  })

  const surfacePath = Option.map(target.surface, Struct.get("path"))

  const onSurfacePage = Effect.fn("BrowserSurface.onSurfacePage")(function* () {
    const address = page.url()
    const location = yield* Effect.try({ try: () => new URL(address), catch: failure("runtime") })

    return Option.contains(surfacePath, location.pathname)
  })

  // The surface's own ready selector settles it because a custom page has no generated loading notices to wait for.
  const awaitSurface = (surface: SurfaceBinding) => settled(surface.ready)

  // A reloaded or reopened page settles on whichever surface it shows because the custom surface has no generated navigation.
  const loaded = Effect.fn("BrowserSurface.loaded")(function* (boundary: string) {
    const custom = yield* onSurfacePage()
    const surface = Option.filter(target.surface, Function.constant(custom))

    yield* Option.match(surface, { onNone: () => started(boundary), onSome: flow(awaitSurface, Effect.asVoid, Effect.mapError(rebound(boundary))) })
  })

  const currentListing = Effect.fn("BrowserSurface.listing")(function* (current: Rendered) {
    const tracked = yield* Ref.get(lists)

    return listingOf(current, tracked)
  })

  const requireOrigin = Effect.fn("BrowserSurface.requireOrigin")(function* (current: Rendered) {
    const location = yield* Effect.try({ try: () => new URL(current.url), catch: failure("runtime") })

    if (!Equal.equals(location.origin, url.origin)) return yield* leftOrigin
  })

  const requireAvailable = Effect.fn("BrowserSurface.requireAvailable")(function* (locator: Locator) {
    const count = yield* Effect.tryPromise({ try: () => locator.count(), catch: failure("runtime") })

    if (!Equal.equals(count, 1)) return yield* unavailableTarget

    const visible = yield* Effect.tryPromise({ try: () => locator.isVisible(), catch: failure("runtime") })

    if (!visible) return yield* unavailableTarget

    const enabled = yield* Effect.tryPromise({ try: () => locator.isEnabled(), catch: failure("runtime") })

    if (!enabled) return yield* unavailableTarget
  })

  const advance = Effect.fn("BrowserSurface.advance")(function* () {
    yield* Ref.update(epoch, next)
    yield* Ref.set(offers, noOffers)
  })

  const clickAwaiting = (locator: Locator, operation: string, wait: number) => {
    const awaited = operationCallOf(url.origin, operation)

    return Effect.tryPromise({
      try: () => {
        const responded = page.waitForResponse(awaited, { timeout: wait })
        const clicked = locator.click()

        return Promise.all([responded, clicked])
      },
      catch: failure("runtime"),
    })
  }

  const showList = Effect.fn("BrowserSurface.showList")(function* (locator: Locator, operation: string) {
    yield* clickAwaiting(locator, operation, timeout)
    yield* pipe(operation, listReady, settled)
  })

  const showForm = Effect.fn("BrowserSurface.showForm")(function* (locator: Locator, operation: string) {
    yield* Effect.tryPromise({ try: () => locator.click(), catch: failure("runtime") })
    yield* pipe(operation, formReady, settled)
  })

  const authenticate = Effect.fn("BrowserSurface.authenticate")(function* (token: Redacted.Redacted<string>) {
    const field = page.locator(tokenInput)

    yield* requireAvailable(field)
    yield* advance()

    const secret = Redacted.value(token)

    yield* Effect.tryPromise({ try: () => field.fill(secret), catch: Function.constant(tokenRefused) })
  }, Effect.mapError(rebound("browser.authenticate")))

  const view = Effect.fn("BrowserSurface.view")(function* (reloaded: boolean, screenshot: string) {
    const current = yield* state()
    const listed = yield* currentListing(current)
    const surface = yield* surfaceState()
    const shown = Option.filter(surface, onSurface)
    const observed = Option.match(shown, { onNone: Function.constant(listed), onSome: surfaceListing })
    const destination = resolve(artifacts, screenshot)
    const directory = resolve(destination, "..")
    const path = relative(artifacts, destination)
    const empty = Equal.equals(path, "")
    const absolute = isAbsolute(path)
    const parent = Equal.equals(path, "..")
    const above = path.startsWith("../")
    const escapes = Array.some([empty, absolute, parent, above], Boolean)

    if (escapes) return yield* escapedArtifacts

    yield* Effect.tryPromise({ try: () => mkdir(directory, { recursive: true }), catch: failure("runtime") })
    yield* Effect.tryPromise({ try: () => page.screenshot({ path: destination, fullPage: true }), catch: failure("runtime") })

    const survived = yield* Ref.get(pageReloaded)

    return Observation.make({
      operation: observed.operation,
      resource: observed.resource,
      loaded: observed.loaded,
      unfiltered: observed.unfiltered,
      complete: observed.complete,
      rows: observed.rows,
      reloaded: reloaded && survived,
      screenshot: Option.some(destination),
    })
  })

  const observe = flow(view, Effect.mapError(rebound("browser.observe")))

  const capture = Effect.fn("BrowserSurface.capture")(function* (operation: string, reloaded: boolean, screenshot: string) {
    if (!isListOperation(operation)) return yield* unlistedOperation

    const custom = yield* onSurfacePage()

    // Observations always go through the generated lists because custom surfaces are exercised, not trusted as evidence.
    if (custom) {
      yield* advance()
      yield* Effect.tryPromise({ try: () => page.goto(target.url, { waitUntil: "domcontentloaded" }), catch: failure("runtime") })
      yield* started("runtime")
    }

    const current = yield* state()

    yield* requireOrigin(current)

    const entries = Array.filter(current.navigation, usableEntry)
    const preferred = preferredEntry(entries)(operation)
    const entry = yield* required(preferred, unavailableTarget)
    const operationTarget = isOperationTarget(entry)
    const selector = navigationSelector(operationTarget, operation)
    const locator = page.locator(selector)

    yield* requireAvailable(locator)
    yield* advance()
    yield* showList(locator, operation)

    return yield* view(reloaded, screenshot)
  }, Effect.mapError(rebound("browser.capture")))

  const actions = Effect.fn("BrowserSurface.actions")(function* (offer: Offer) {
    const current = yield* state()

    yield* requireOrigin(current)

    const surface = yield* surfaceState()
    const hash = yield* snapshot(current, surface)
    const listed = yield* currentListing(current)
    const turn = Turn.make({ offer, current, listed, surface, snapshot: hash })
    const offered = offeredActions(turn)

    if (offered.length > maximumActions) return yield* oversizedCatalog

    const entries = Array.map(offered, offeredEntry(offer))
    const catalog = HashMap.fromIterable(entries)

    yield* Ref.set(offers, catalog)

    return offered
  }, Effect.mapError(rebound("browser.actions")))

  const navigate = Effect.fn("BrowserSurface.navigate")(function* (action: Action, binding: Offered) {
    const observing = Equal.equals(action.kind, "observe")
    const scoped = Option.filter(action.operation, offeredScope(binding.offer, observing))
    const operation = yield* required(scoped, outsideOffer)
    const operationTarget = action.target.endsWith(":operation")
    const selector = navigationSelector(operationTarget, operation)
    const locator = page.locator(selector)

    yield* requireAvailable(locator)
    yield* advance()
    yield* observing ? showList(locator, operation) : showForm(locator, operation)

    return Option.none<Submission>()
  })

  const reload = Effect.fn("BrowserSurface.reload")(function* (action: Action, binding: Offered) {
    const targeted = Equal.equals(action.target, "page")
    const permitted = binding.offer.reload && targeted

    if (!permitted) return yield* reloadUnavailable

    yield* advance()
    yield* Ref.update(lists, HashMap.map(forget))
    yield* Effect.tryPromise({ try: () => page.reload({ waitUntil: "domcontentloaded" }), catch: failure("runtime") })
    yield* loaded("runtime")
    yield* Ref.set(pageReloaded, true)

    return Option.none<Submission>()
  })

  const inclusionAvailable = (form: Locator) => (inclusion: Inclusion) => {
    const selector = attributeSelector("data-inclusion-path", inclusion.path)
    const toggle = form.locator(selector)

    return requireAvailable(toggle)
  }

  const toggleInclusion = (form: Locator, input: Payload) => (inclusion: Inclusion) => {
    const proposed = atPath(input, inclusion.path)
    const included = Option.isSome(proposed)
    const selector = attributeSelector("data-inclusion-path", inclusion.path)
    const toggle = form.locator(selector)

    return Effect.tryPromise({ try: () => toggle.setChecked(included), catch: failure("runtime") })
  }

  const check = Effect.fn("BrowserSurface.check")(function* (field: Locator, value: unknown) {
    if (!Predicate.isBoolean(value)) return yield* nonBooleanCheckbox

    yield* Effect.tryPromise({ try: () => field.setChecked(value), catch: failure("runtime") })
  })

  const enter = (control: Control, field: Locator) => Effect.fn("BrowserSurface.enter")(function* (value: unknown) {
    const serialized = JSON.stringify(value)

    if (Equal.equals(control.tag, "SELECT")) return yield* pipe(Effect.tryPromise({ try: () => field.selectOption(serialized), catch: failure("runtime") }), Effect.asVoid)

    if (Equal.equals(control.type, "checkbox")) return yield* check(field, value)

    const stringified = String(value)
    const representation = Equal.equals(control.tag, "TEXTAREA") ? Option.fromUndefinedOr(serialized) : Option.some(stringified)
    const text = yield* required(representation, unrepresentable)

    yield* Effect.tryPromise({ try: () => field.fill(text), catch: failure("runtime") })
  })

  const fillControl = (candidate: Candidate, form: Locator) => Effect.fn("BrowserSurface.fillControl")(function* (control: Control) {
    const proposed = atPath(candidate.input, control.path)
    const selector = attributeSelector("data-input-path", control.path)
    const field = form.locator(selector)

    yield* requireAvailable(form)
    yield* requireAvailable(field)
    yield* Effect.forEach(control.inclusions, inclusionAvailable(form), { discard: true })
    yield* Effect.forEach(control.inclusions, toggleInclusion(form, candidate.input), { discard: true })
    yield* Option.match(proposed, { onNone: Function.constant(Effect.void), onSome: enter(control, field) })

    const updated = yield* state()

    const retained = pipe(
      updated.form,
      Option.filter(operationIs(candidate.operation)),
      Option.flatMap(controlAt(control.path)),
      Option.exists(matches(candidate.input)),
    )

    if (!retained) return yield* unretainedControl
  })

  const fill = Effect.fn("BrowserSurface.fill")(function* (action: Action, candidate: Candidate, form: Form, locator: Locator) {
    const targeted = Equal.equals(action.target, `payload:${candidate.inputCase}`)
    const exact = Option.exists(action.value, sameCanonical(candidate.input))
    const approved = targeted && exact

    if (!approved) return yield* unapprovedPayload

    const outstanding = Array.filter(form.controls, Predicate.not(matches(candidate.input)))

    yield* advance()
    yield* Effect.forEach(outstanding, fillControl(candidate, locator), { discard: true })

    return Option.none<Submission>()
  })

  const submit = Effect.fn("BrowserSurface.submit")(function* (action: Action, candidate: Candidate, form: Form, locator: Locator) {
    const targeted = Equal.equals(action.target, `submit:${candidate.inputCase}`)
    const exact = Option.exists(action.value, sameCanonical(candidate.input))
    const covered = coversInput(form)(candidate.input)
    const complete = Array.every(form.controls, matches(candidate.input))
    const permitted = Array.every([targeted, exact, covered, complete], Boolean)

    if (!permitted) return yield* incompleteSubmission

    const button = locator.locator("button[data-action='submit']")

    yield* requireAvailable(button)
    yield* advance()

    const gate = yield* RequestGate
    const clicking = clickAwaiting(button, candidate.operation, submissionTimeout)
    const [response] = yield* Option.match(gate, { onNone: Function.constant(clicking), onSome: heldWhile(clicking, candidate) })
    const settle = pipe(submissionReady, waitUntilSettled)

    return yield* submissionOf(response, candidate, settle)
  })

  const unroute = Effect.fn("BrowserSurface.unroute")(function* (handler: (route: Route) => Promise<void>) {
    yield* Effect.tryPromise({ try: () => page.unroute(callEndpoint, handler), catch: Function.identity })
  }, Effect.catch(logRouteFailure))

  /**
   * Routes the candidate's own call through the lane's hold while the unchanged click runs, because a concurrent barrier must release
   * requests that are already pending at the network boundary; other calls pass through and the route is removed once the click settles.
   */
  const heldWhile = <A>(clicking: Effect.Effect<A, AcceptanceError>, candidate: Candidate) => (hold: (inputCase: string) => Effect.Effect<void, AcceptanceError>) => {
    const matches = requestsOperation(candidate.operation)
    const held = hold(candidate.inputCase)
    const handler = holdRoute(matches, held)
    const routed = Effect.tryPromise({ try: () => page.route(callEndpoint, handler), catch: failure("runtime") })
    const unrouted = unroute(handler)

    return pipe(routed, Effect.andThen(clicking), Effect.ensuring(unrouted))
  }

  const feedbackOf = (rendered: Result.Result<Rendered, AcceptanceError>) => pipe(
    Result.getSuccess(rendered),
    Option.flatMap(Struct.get("result")),
    Option.map(flow(Struct.get("shown"), Text.trim)),
    Option.filter(Text.isNonEmpty),
  )

  // The response is the awaited call of the candidate's own operation, captured before any follow-up refresh, because only that request proves what was submitted.
  const submissionOf = Effect.fn("BrowserSurface.submissionOf")(function* (response: Response, candidate: Candidate, settle: Effect.Effect<unknown, unknown>) {
    const request = response.request()
    const call = yield* pipe(request, decodeRequest, Effect.mapError(failure("runtime")))
    const envelope = yield* pipe(response, decodeEnvelope, Effect.result)
    const exchange = exchangeOf(request)
    const settlement = yield* Effect.result(settle)
    const rendering = state()
    const rendered = yield* Effect.result(rendering)
    const feedback = feedbackOf(rendered)
    const at = yield* now
    const answered = Result.match(envelope, { onFailure: undecodedResponse, onSuccess: bodyError })
    const result = Result.match(envelope, { onFailure: Function.constant(noResult), onSuccess: resultOf })
    const sameInput = sameCanonical(call.input)(candidate.input)
    const sameOperation = Equal.equals(call.operation, candidate.operation)
    const exact = sameInput && sameOperation
    const differs = !exact
    const observed = Result.match(settlement, { onFailure: unsettledInterface(answered), onSuccess: Function.constant(answered) })
    const error = differs ? submittedMismatch(answered) : observed
    const status = response.status()
    const submission = Submission.make({ inputCase: candidate.inputCase, operation: call.operation, input: call.input, status, result, error, at, exchange, feedback })

    return Option.some(submission)
  })

  const operate = Effect.fn("BrowserSurface.operate")(function* (action: Action, binding: Offered, current: Rendered) {
    const candidate = yield* required(binding.candidate, unapprovedPayload)
    const requested = Option.exists(action.operation, Equal.equals(candidate.operation))
    const active = pipe(current.form, Option.filter(activeForm(candidate.operation)), Option.filter(Function.constant(requested)))
    const form = yield* required(active, inactiveForm)
    const selector = formSelector(candidate.operation)
    const locator = page.locator(selector)

    yield* requireAvailable(locator)

    return yield* Equal.equals(action.kind, "fill") ? fill(action, candidate, form, locator) : submit(action, candidate, form, locator)
  })

  const count = (locator: Locator) => Effect.tryPromise({ try: () => locator.count(), catch: failure("runtime") })
  const locate = locatorsFor(page)

  const requireSemantics = Effect.fn("BrowserSurface.requireSemantics")(function* (located: LocatedPart) {
    const both = located.declared.and(located.semantic)
    const matched = yield* count(both)

    if (!Equal.equals(matched, 1)) return yield* semanticMismatch
  })

  const requireLocated = Effect.fn("BrowserSurface.requireLocated")(function* (located: LocatedPart) {
    yield* requireAvailable(located.declared)
    yield* requireSemantics(located)
  })

  const diagnose = Effect.fn("BrowserSurface.diagnose")(function* (recorded: Action) {
    const target = yield* required(recorded.binding, notRepairable)
    const identity = boundIdentity(recorded, target)
    const located = locate(target, identity)
    const counts = yield* pipe(located, Array.map(Struct.get("declared")), Effect.forEach(count))
    const pairs = Array.zip(located, counts)

    return pipe(pairs, Array.map(describeCount), Array.join("; "))
  }, Effect.mapError(rebound("browser.diagnose")))

  const checkPart = Effect.fn("BrowserSurface.checkPart")(function* ([before, after]: readonly [LocatedPart, LocatedPart]) {
    const shared = after.semantic.and(after.declared)
    const recordedMatches = yield* count(before.declared)
    const currentMatches = yield* count(after.declared)
    const semanticMatches = yield* count(after.semantic)
    const sharedMatches = yield* count(shared)

    return LocatorCheck.make({
      part: after.part.part,
      recorded: before.declaredText,
      recordedMatches,
      current: after.declaredText,
      currentMatches,
      semantic: after.semanticText,
      semanticMatches,
      sameElement: Equal.equals(sharedMatches, 1),
    })
  })

  /**
   * Verifies a repair on the live page: some recorded locator must no longer resolve to exactly one element, and every part's semantic
   * target must resolve to exactly one element that is the current binding's element. Anything else refuses the repair.
   */
  const repair = Effect.fn("BrowserSurface.repair")(function* (recorded: Action, current: Action) {
    const recordedTarget = yield* required(recorded.binding, notRepairable)
    const currentTarget = yield* required(current.binding, notRepairable)
    const identity = boundIdentity(current, currentTarget)
    const recordedIdentity = boundIdentity(recorded, recordedTarget)
    const sameIdentity = Equal.equals(identity, recordedIdentity)
    const sameParts = Equal.equals(recordedTarget.parts.length, currentTarget.parts.length)
    const comparable = sameIdentity && sameParts

    if (!comparable) return yield* repairFailure("The repaired action does not target the recorded row with the same bound elements")

    const recordedLocated = locate(recordedTarget, identity)
    const currentLocated = locate(currentTarget, identity)
    const pairs = Array.zip(recordedLocated, currentLocated)
    const checks = yield* Effect.forEach(pairs, checkPart)
    const failed = Array.filter(checks, failedPart)
    const summary = pipe(checks, Array.map(describeCheck), Array.join("; "))
    const unrepaired = !Array.every(checks, repairedPart)

    if (Array.isReadonlyArrayEmpty(failed)) return yield* repairFailure(`Every recorded locator still resolves to exactly one element, so the unavailability is not a locator failure: ${summary}`)

    if (unrepaired) return yield* repairFailure(`The declared semantic target does not resolve to exactly the current binding's element: ${summary}`)

    const failure = pipe(failed, Array.map(describeRecorded), Array.join("; "))

    return LocatorRepair.make({
      surface: currentTarget.surface,
      action: currentTarget.action,
      operation: current.operation,
      inputCase: current.inputCase,
      identity,
      originalTarget: recorded.target,
      repairedTarget: current.target,
      failure,
      semantics: currentTarget.parts,
      checks,
    })
  }, Effect.mapError(asRepairFailure))

  const openSurface = Effect.fn("BrowserSurface.openSurface")(function* (surface: SurfaceBinding) {
    const destination = yield* Effect.try({ try: () => new URL(surface.path, url.origin).href, catch: failure("runtime") })

    yield* advance()
    yield* Effect.tryPromise({ try: () => page.goto(destination, { waitUntil: "domcontentloaded" }), catch: failure("runtime") })
    yield* awaitSurface(surface)

    return Option.none<Submission>()
  })

  const refreshSurface = Effect.fn("BrowserSurface.refreshSurface")(function* (surface: SurfaceBinding, target: CustomTarget) {
    const unbound = Option.none<string>()
    const located = locate(target, unbound)
    const first = Array.head(located)
    const refresh = yield* required(first, unavailableTarget)

    yield* requireLocated(refresh)
    yield* advance()
    yield* clickAwaiting(refresh.declared, surface.source, timeout)
    yield* awaitSurface(surface)

    return Option.none<Submission>()
  })

  const enterText = (kind: ControlBinding["kind"], field: Locator) => (text: string) => {
    const select = Equal.equals(kind, "select")
    const selected = Effect.tryPromise({ try: () => field.selectOption(text), catch: failure("runtime") })
    const filled = Effect.tryPromise({ try: () => field.fill(text), catch: failure("runtime") })

    return select ? Effect.asVoid(selected) : filled
  }

  const fillRowControl = (action: ActionBinding, input: Payload) => Effect.fn("BrowserSurface.fillRowControl")(function* (located: LocatedPart) {
    const declared = controlOfPart(action)(located.part)
    const control = yield* required(declared, unavailableTarget)
    const text = controlText(action, input)(control.name)

    yield* requireLocated(located)
    yield* enterText(control.kind, located.declared)(text)

    const retained = yield* Effect.tryPromise({ try: () => located.declared.inputValue(), catch: failure("runtime") })

    if (!Equal.equals(retained, text)) return yield* unretainedControl
  })

  // A row action re-checks identity, payload, and controls against a fresh scan, then acts only inside the bound row, because a stale or swapped row must never execute.
  const operateRow = Effect.fn("BrowserSurface.operateRow")(function* (action: Action, target: CustomTarget, offered: Offered, turn: SurfaceTurn) {
    const candidate = yield* required(offered.candidate, unapprovedPayload)
    const declared = actionBindingOf(turn.binding, target)
    const bound = yield* required(declared, unapprovedPayload)
    const exact = Option.exists(action.value, sameCanonical(candidate.input))
    const requested = Option.contains(action.operation, candidate.operation)
    const approved = exact && requested

    if (!approved) return yield* unapprovedPayload

    const claimed = candidateIdentity(bound, candidate.input)
    const identity = yield* required(claimed, wrongRow)
    const single = boundRow(turn.scan)(identity)
    const scanned = yield* required(single, wrongRow)
    const ready = rowActionReady(turn, bound, candidate)(scanned)

    if (!ready) return yield* wrongRow

    const bindingIdentity = Option.some(identity)
    const located = locate(target, bindingIdentity)
    const rowPart = Array.findFirst(located, partNamed("row"))
    const triggerPart = Array.findFirst(located, partNamed("trigger"))
    const row = yield* required(rowPart, wrongRow)
    const trigger = yield* required(triggerPart, unavailableTarget)
    const controls = Array.filter(located, isControlPart)

    yield* requireLocated(row)
    yield* advance()
    yield* Effect.forEach(controls, fillRowControl(bound, candidate.input), { discard: true })
    yield* requireLocated(trigger)

    const [response] = yield* clickAwaiting(trigger.declared, candidate.operation, submissionTimeout)
    const settle = settled(bound.settle)

    return yield* submissionOf(response, candidate, settle)
  })

  const operateSurface = Effect.fn("BrowserSurface.operateSurface")(function* (action: Action, target: CustomTarget, offered: Offered, surface: Option.Option<SurfaceTurn>) {
    const named = Option.filter(surface, surfaceNamed(target.surface))
    const turn = yield* required(named, unboundSurface)

    if (Equal.equals(target.action, "open")) return yield* openSurface(turn.binding)

    if (Equal.equals(target.action, "rows")) return yield* refreshSurface(turn.binding, target)

    return yield* operateRow(action, target, offered, turn)
  })

  const execute = Effect.fn("BrowserSurface.execute")(function* (action: Action) {
    const offered = yield* Ref.get(offers)
    const found = HashMap.get(offered, action.id)
    const binding = yield* required(found, alteredAction)
    const offeredKey = yield* encodeAction(binding.action)
    const requestedKey = yield* encodeAction(action)

    if (!Equal.equals(offeredKey, requestedKey)) return yield* alteredAction

    const current = yield* state()
    const surface = yield* surfaceState()
    const hash = yield* snapshot(current, surface)

    if (!Equal.equals(hash, action.snapshot)) return yield* staleSnapshot

    yield* requireOrigin(current)

    if (Equal.equals(action.kind, "cannot-proceed")) return yield* modelCannotProceed

    if (Option.isSome(action.binding)) return yield* operateSurface(action, action.binding.value, binding, surface)

    const navigation = Array.contains(navigationKinds, action.kind)

    if (navigation) return yield* navigate(action, binding)

    if (Equal.equals(action.kind, "reload")) return yield* reload(action, binding)

    return yield* operate(action, binding, current)
  }, Effect.mapError(rebound("browser.execute")))

  return BrowserSurface.of({ authenticate, observe, capture, actions, execute, diagnose, repair })
})

export const browserLayer = (target: BrowserTarget) => pipe(target, makeSurface, Layer.effect(BrowserSurface))
