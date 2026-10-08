import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { chromium, type Locator, type Page, type Response } from "playwright"
import { AcceptanceError, BrowserSurface, PayloadSchema, type Action, type Candidate, type Observation, type Payload, type Scenario, type Submission } from "./model.ts"

const timeout = 7_000
const CallSchema = Schema.Struct({ operation: Schema.String, input: PayloadSchema })
const ResultSchema = Schema.Record(Schema.String, Schema.Unknown)
const ListResultSchema = Schema.Struct({ items: Schema.Array(PayloadSchema), nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)) })
type ListResult = Schema.Schema.Type<typeof ListResultSchema>
const decodeCall = Schema.decodeUnknownSync(CallSchema)
const decodeResult = Schema.decodeUnknownSync(ResultSchema)
const decodeList = Schema.decodeUnknownSync(ListResultSchema)

interface ControlState {
  path: string
  tag: string
  type: string
  value: string
  checked: boolean
  visible: boolean
  enabled: boolean
  inclusions: ReadonlyArray<{ path: string; checked: boolean; enabled: boolean; visible: boolean }>
}
interface RenderedState {
  url: string
  navigation: ReadonlyArray<{ operation: string; target: string; label: string; visible: boolean; enabled: boolean }>
  form?: { operation: string; controls: ReadonlyArray<ControlState>; submitVisible: boolean; submitEnabled: boolean; fallback: string }
  table?: {
    operation: string
    resource: string
    identifier: string
    loaded: boolean
    unfiltered: boolean
    complete: boolean
    input: string
    rows: ReadonlyArray<{ identity: string; cells: ReadonlyArray<{ column: string; value: string; text: string }> }>
  }
  loading: boolean
  errors: ReadonlyArray<string>
}
interface ListEvidence {
  operation: string
  input: Payload
  result: ListResult
}
interface Offered {
  action: Action
  scenario: Scenario
  candidate: Candidate
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

const atPath = (input: Payload, path: string): { present: boolean; value?: unknown } => {
  let value: unknown = input
  for (const segment of path.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, segment)) return { present: false }
    value = Reflect.get(value, segment)
  }
  return { present: true, value }
}

const controlValue = (control: ControlState): unknown => {
  if (control.tag === "TEXTAREA" || control.tag === "SELECT") return JSON.parse(control.value)
  if (control.type === "checkbox") return control.checked
  if (control.type === "number") return control.value.trim() === "" ? undefined : Number(control.value)
  return control.value
}

const matches = (control: ControlState, input: Payload): boolean => {
  const candidate = atPath(input, control.path)
  const included = control.inclusions.every((inclusion) => inclusion.checked)
  if (!candidate.present) return !included
  if (!included) return false
  try {
    return canonical(controlValue(control)) === canonical(candidate.value)
  } catch {
    return false
  }
}

const responseJson = async (response: Response): Promise<unknown> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      response.json(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AcceptanceError({ boundary: "runtime", message: "Public response body exceeded the browser deadline" })), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const rendered = async (page: Page): Promise<RenderedState> => page.evaluate(() => {
  const visible = (node: HTMLElement) => node.checkVisibility() && node.getClientRects().length > 0
  const enabled = (node: HTMLElement) => !node.matches(":disabled") && node.getAttribute("aria-disabled") !== "true"
  const navigation = Array.from(document.querySelectorAll<HTMLButtonElement>(".admin-nav button[data-operation]")).map((node) => ({
    operation: node.dataset.operation ?? "",
    target: node.classList.contains("admin-nav-operation") ? "operation" : "resource",
    label: node.textContent ?? "",
    visible: visible(node),
    enabled: enabled(node),
  }))
  const node = document.querySelector<HTMLFormElement>(".admin-content form.admin-form[data-operation]")
  const submit = node?.querySelector<HTMLButtonElement>("button[data-action='submit']")
  const controls = node ? Array.from(node.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-input-path]")).map((control) => {
    const inclusions: Array<{ path: string; checked: boolean; enabled: boolean; visible: boolean }> = []
    let ancestor: HTMLElement | null = control.parentElement
    while (ancestor && ancestor !== node) {
      const inclusion = ancestor.querySelector<HTMLInputElement>(":scope > .admin-optional > input[data-inclusion-path]")
      if (inclusion) inclusions.push({ path: inclusion.dataset.inclusionPath ?? "", checked: inclusion.checked, enabled: enabled(inclusion), visible: visible(inclusion) })
      ancestor = ancestor.parentElement
    }
    return {
      path: control.dataset.inputPath ?? "",
      tag: control.tagName,
      type: control instanceof HTMLInputElement ? control.type : "",
      value: control.value,
      checked: control instanceof HTMLInputElement && control.checked,
      visible: visible(control),
      enabled: enabled(control),
      inclusions,
    }
  }) : []
  const table = document.querySelector<HTMLTableElement>(".admin-content table[data-resource]")
  return {
    url: location.href,
    navigation,
    ...(node ? { form: {
      operation: node.dataset.operation ?? "",
      controls,
      submitVisible: submit ? visible(submit) : false,
      submitEnabled: submit ? enabled(submit) : false,
      fallback: node.querySelector<HTMLTextAreaElement>(".admin-json-fallback textarea")?.value ?? "",
    } } : {}),
    ...(table && visible(table) ? { table: {
      operation: table.dataset.operation ?? "",
      resource: table.dataset.resource ?? "",
      identifier: table.dataset.identifier ?? "",
      loaded: table.dataset.loaded === "true" && table.parentElement?.dataset.loaded === "true",
      unfiltered: table.dataset.unfiltered === "true",
      complete: table.dataset.complete === "true",
      input: table.dataset.requestInput ?? "",
      rows: Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody > tr")).map((row) => ({
        identity: row.dataset.rowIdentity ?? "",
        cells: Array.from(row.querySelectorAll<HTMLTableCellElement>("td[data-column]")).map((cell) => ({ column: cell.dataset.column ?? "", value: cell.dataset.value ?? "", text: cell.textContent ?? "" })),
      })),
    } } : {}),
    loading: Array.from(document.querySelectorAll<HTMLElement>(".admin-content .admin-notice-loading")).some(visible),
    errors: Array.from(document.querySelectorAll<HTMLElement>(".admin-content [role='alert']")).map((error) => error.textContent ?? ""),
  }
})

export const browserLayer = (options: Readonly<{ url: string; artifacts: string }>) => Layer.effect(
  BrowserSurface,
  Effect.gen(function* () {
    const attempt = <A>(boundary: string, run: () => Promise<A>) => Effect.tryPromise({
      try: run,
      catch: (cause) => new AcceptanceError({ boundary, message: cause instanceof Error ? cause.message : String(cause) }),
    })
    const origin = yield* Effect.try({
      try: () => {
        const url = new URL(options.url)
        if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new AcceptanceError({ boundary: "runtime", message: "Browser acceptance requires an isolated localhost HTTP application" })
        return url.origin
      },
      catch: (cause) => new AcceptanceError({ boundary: "browser.open", message: String(cause) }),
    })
    const artifacts = resolve(options.artifacts)
    yield* attempt("browser.artifacts", () => mkdir(artifacts, { recursive: true }))
    const browser = yield* Effect.acquireRelease(
      attempt("browser.launch", () => chromium.launch({ timeout })),
      (browser) => Effect.promise(() => browser.close()),
    )
    const context = yield* Effect.acquireRelease(
      attempt("browser.context", () => browser.newContext({ viewport: { width: 1280, height: 900 } })),
      (context) => Effect.promise(() => context.close()),
    )
    const page = yield* attempt("browser.page", () => context.newPage())
    page.setDefaultTimeout(timeout)
    page.setDefaultNavigationTimeout(timeout)
    let epoch = 0
    let hasReloaded = false
    let listEvidence: ListEvidence | undefined
    let listSequence = 0
    const pending = new Set<Promise<void>>()
    const offered = new Map<string, Offered>()

    const isPublicCall = (response: Response) => {
      const url = new URL(response.url())
      return url.origin === origin && url.pathname.endsWith("/api/call") && response.request().method() === "POST"
    }
    const onResponse = (response: Response) => {
      if (!isPublicCall(response)) return
      const sequence = ++listSequence
      const work = (async () => {
        try {
          const request = decodeCall(response.request().postDataJSON())
          if (request.operation !== "books.list" || !response.ok()) return
          const body = decodeResult(await responseJson(response))
          const result = decodeList(body.result)
          if (sequence === listSequence) listEvidence = { operation: request.operation, input: request.input, result }
        } catch {
          if (sequence === listSequence) listEvidence = undefined
        }
      })()
      pending.add(work)
      void work.finally(() => pending.delete(work))
    }
    page.on("response", onResponse)
    yield* Effect.addFinalizer(() => Effect.sync(() => page.off("response", onResponse)))
    yield* attempt("browser.open", async () => {
      await page.goto(options.url, { waitUntil: "domcontentloaded" })
      await page.locator(".admin-nav button[data-operation='books.list']").first().waitFor({ state: "visible" })
      await page.waitForFunction(() => !document.querySelector(".admin-notice-loading"), undefined, { timeout })
    })

    const state = async () => {
      await Promise.all(pending)
      return rendered(page)
    }
    const snapshot = (current: RenderedState) => createHash("sha256").update(canonical({ epoch, current })).digest("hex")
    const assertAvailable = async (locator: Locator) => {
      if (await locator.count() !== 1 || !await locator.isVisible() || !await locator.isEnabled()) throw new AcceptanceError({ boundary: "runtime", message: "The semantic target is missing, ambiguous, hidden, or disabled" })
    }
    const navigationLocator = (action: Action) => {
      const target = action.target.endsWith(":operation") ? ".admin-nav-operation" : ".admin-nav-resource"
      return page.locator(`${target}[data-operation=${JSON.stringify(action.operation)}]`)
    }
    const formLocator = (operation: string) => page.locator(`.admin-content form.admin-form[data-operation=${JSON.stringify(operation)}]`)
    const settled = async () => {
      await page.waitForFunction(() => !document.querySelector(".admin-content .admin-notice-loading") && (
        document.querySelector(".admin-content table[data-loaded='true']") ||
        document.querySelector(".admin-content form.admin-form button[data-action='submit']:not(:disabled)") ||
        document.querySelector(".admin-content [role='alert']")
      ), undefined, { timeout })
    }

    const rowsFrom = (current: RenderedState): { loaded: boolean; unfiltered: boolean; rows: ReadonlyArray<Payload> } => {
      const table = current.table
      if (!table || table.resource !== "books" || table.operation !== "books.list" || !table.identifier) return { loaded: false, unfiltered: false, rows: [] }
      const rows: Array<Payload> = []
      try {
        const identities = new Set<string>()
        for (const row of table.rows) {
          const fields: Record<string, unknown> = {}
          for (const cell of row.cells) {
            if (!cell.column || Object.hasOwn(fields, cell.column)) throw new AcceptanceError({ boundary: "runtime", message: "Ambiguous rendered column" })
            const value: unknown = JSON.parse(cell.value)
            const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
            if (cell.text !== text) throw new AcceptanceError({ boundary: "runtime", message: "Rendered cell disagrees with its value binding" })
            fields[cell.column] = value
          }
          const decoded = Schema.decodeUnknownSync(PayloadSchema)(fields)
          if (!row.identity || canonical(decoded[table.identifier]) !== canonical(JSON.parse(row.identity)) || identities.has(row.identity)) throw new AcceptanceError({ boundary: "runtime", message: "Missing, duplicate, or mismatched row identity" })
          identities.add(row.identity)
          rows.push(decoded)
        }
        const input = Schema.decodeUnknownSync(PayloadSchema)(JSON.parse(table.input))
        const unfiltered = table.unfiltered && !Object.hasOwn(input, "filter") && !Object.hasOwn(input, "cursor")
        const evidence = listEvidence
        const complete = table.complete && evidence && evidence.operation === table.operation && canonical(evidence.input) === canonical(input) && evidence.result.nextCursor == null && evidence.result.items.length === rows.length && evidence.result.items.every((item) => rows.some((row) => canonical(row) === canonical(item)))
        return { loaded: Boolean(table.loaded && !current.loading && unfiltered && complete), unfiltered, rows }
      } catch {
        return { loaded: false, unfiltered: false, rows }
      }
    }

    const observe = Effect.fn("BrowserSurface.observe")(function* (reloaded: boolean, screenshot: string) {
      return yield* attempt("browser.observe", async (): Promise<Observation> => {
        const current = await state()
        const observed = rowsFrom(current)
        const destination = resolve(artifacts, screenshot)
        const path = relative(artifacts, destination)
        if (!path || isAbsolute(path) || path === ".." || path.startsWith("../")) throw new AcceptanceError({ boundary: "runtime", message: "Screenshot must be a file within the scenario artifact directory" })
        await mkdir(resolve(destination, ".."), { recursive: true })
        await page.screenshot({ path: destination, fullPage: true })
        return { ...observed, resource: current.table?.resource ?? "books", reloaded: reloaded && hasReloaded, screenshot: destination }
      })
    })

    const actions = Effect.fn("BrowserSurface.actions")(function* (scenario: Scenario, candidate: Candidate, submitted: boolean, reloaded: boolean) {
      return yield* attempt("browser.actions", async (): Promise<ReadonlyArray<Action>> => {
        if (scenario.resource !== "books" || !["books.create", "books.update"].includes(scenario.operation)) throw new AcceptanceError({ boundary: "runtime", message: "Unsupported browser scenario operation or resource" })
        const current = await state()
        if (new URL(current.url).origin !== origin) throw new AcceptanceError({ boundary: "runtime", message: "Browser left the isolated application origin" })
        const hash = snapshot(current)
        const result: Array<Action> = []
        offered.clear()
        const offer = (action: Omit<Action, "snapshot">) => {
          const complete = { ...action, snapshot: hash }
          result.push(complete)
          offered.set(action.id, { action: complete, scenario, candidate })
        }
        if (!current.loading) {
          const navigation = current.navigation.filter((entry) => entry.visible && entry.enabled && (entry.operation === "books.list" || !submitted && entry.operation === scenario.operation))
          const unique = new Map<string, typeof navigation[number]>()
          for (const entry of navigation) {
            if (!unique.has(entry.operation) || entry.target === "operation") unique.set(entry.operation, entry)
          }
          for (const entry of unique.values()) {
            if (entry.operation === scenario.operation && current.form?.operation === scenario.operation || entry.operation === "books.list" && rowsFrom(current).loaded) continue
            offer({ id: `open:${entry.operation}`, kind: entry.operation === "books.list" ? "observe" : "open", operation: entry.operation, target: `navigation:${entry.operation}:${entry.target}`, description: entry.operation === "books.list" ? "Open the complete, unfiltered Books list to observe all current records" : `Open ${entry.label} for the requested ${scenario.operation} operation` })
          }
          const form = current.form
          if (!submitted && form?.operation === scenario.operation && !form.fallback.trim()) {
            const unavailable: Array<string> = []
            for (const control of form.controls) {
              if (matches(control, candidate.input)) continue
              const proposed = atPath(candidate.input, control.path)
              const canInclude = control.inclusions.every((inclusion) => inclusion.enabled && inclusion.visible)
              if (!control.visible || !control.enabled || !canInclude || !proposed.present && control.inclusions.length === 0) {
                unavailable.push(control.path)
                continue
              }
            }
            const inputKeys = Object.keys(candidate.input)
            const covered = inputKeys.every((key) => form.controls.some((control) => control.path === `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}` || control.path.startsWith(`/${key.replace(/~/g, "~0").replace(/\//g, "~1")}/`)))
            const missing = form.controls.filter((control) => !matches(control, candidate.input))
            if (covered && unavailable.length === 0 && missing.length > 0) {
              offer({ id: `fill:${scenario.operation}`, kind: "fill", operation: scenario.operation, value: candidate.input, target: `payload:${scenario.operation}`, description: `Enter the exact proposed payload into all ${missing.length} outstanding individual generated controls (${missing.map((control) => control.path).join(", ")}), including the existing target identity and unchanged values; do not submit yet` })
            }
            if (covered && unavailable.length === 0 && form.controls.every((control) => matches(control, candidate.input)) && form.submitVisible && form.submitEnabled) {
              offer({ id: `submit:${scenario.operation}`, kind: "submit", operation: scenario.operation, target: `submit:${scenario.operation}`, description: `Run ${scenario.operation} with the exact proposed fields; capture the real public HTTP response` })
            }
          }
          if (submitted && scenario.reload && !reloaded && !hasReloaded && rowsFrom(current).loaded) {
            offer({ id: "reload:page", kind: "reload", target: "page", description: "Reload this page from the server and observe whether the saved record remains visible" })
          }
        }
        offer({ id: "cannot-proceed", kind: "cannot-proceed", target: "scenario", description: "Cannot proceed: no safe available interaction advances the requested goal" })
        if (result.length > 32) throw new AcceptanceError({ boundary: "runtime", message: "Rendered action catalog exceeds the bounded Reading List surface" })
        return result
      })
    })

    const execute = Effect.fn("BrowserSurface.execute")(function* (action: Action) {
      return yield* attempt("browser.execute", async (): Promise<Submission | undefined> => {
        const binding = offered.get(action.id)
        if (!binding || canonical(binding.action) !== canonical(action)) throw new AcceptanceError({ boundary: "runtime", message: "Unknown or altered browser action" })
        const current = await state()
        if (snapshot(current) !== action.snapshot) throw new AcceptanceError({ boundary: "runtime", message: "Stale browser snapshot; obtain fresh rendered actions" })
        if (new URL(current.url).origin !== origin) throw new AcceptanceError({ boundary: "runtime", message: "Browser left the isolated application origin" })
        const { candidate, scenario } = binding
        if (action.kind === "cannot-proceed") throw new AcceptanceError({ boundary: "runtime", message: "The decision model explicitly cannot proceed" })
        if (action.kind === "open" || action.kind === "observe") {
          if (action.operation !== scenario.operation && action.operation !== "books.list") throw new AcceptanceError({ boundary: "runtime", message: "Navigation is outside the scenario" })
          const locator = navigationLocator(action)
          await assertAvailable(locator)
          epoch++
          offered.clear()
          await locator.click()
          await settled()
          return undefined
        }
        if (action.kind === "reload") {
          if (!scenario.reload || !rowsFrom(current).loaded || action.target !== "page") throw new AcceptanceError({ boundary: "runtime", message: "Reload is unavailable outside the complete list view" })
          epoch++
          offered.clear()
          listEvidence = undefined
          await page.reload({ waitUntil: "domcontentloaded" })
          await page.locator(".admin-nav button[data-operation='books.list']").first().waitFor({ state: "visible" })
          await settled()
          hasReloaded = true
          return undefined
        }
        if (action.operation !== scenario.operation || current.form?.operation !== scenario.operation || current.form.fallback.trim()) throw new AcceptanceError({ boundary: "runtime", message: "The requested generated operation form is no longer active" })
        const form = formLocator(scenario.operation)
        await assertAvailable(form)
        if (action.kind === "fill") {
          if (action.target !== `payload:${scenario.operation}` || canonical(action.value) !== canonical(candidate.input)) throw new AcceptanceError({ boundary: "runtime", message: "Payload differs from the approved candidate or operation identity" })
          const controls = current.form.controls.filter((control) => !matches(control, candidate.input))
          for (const control of controls) {
            const proposed = atPath(candidate.input, control.path)
            const locator = form.locator(`[data-input-path=${JSON.stringify(control.path)}]`)
            await assertAvailable(form)
            await assertAvailable(locator)
            for (const inclusion of control.inclusions) await assertAvailable(form.locator(`[data-inclusion-path=${JSON.stringify(inclusion.path)}]`))
            for (const inclusion of control.inclusions) {
              const include = atPath(candidate.input, inclusion.path).present
              await form.locator(`[data-inclusion-path=${JSON.stringify(inclusion.path)}]`).setChecked(include)
            }
            if (proposed.present) {
              if (control.tag === "SELECT") await locator.selectOption(JSON.stringify(proposed.value))
              else if (control.type === "checkbox") {
                if (typeof proposed.value !== "boolean") throw new AcceptanceError({ boundary: "runtime", message: "Checkbox candidate is not a boolean" })
                await locator.setChecked(proposed.value)
              } else {
                const value = control.tag === "TEXTAREA" ? JSON.stringify(proposed.value) : String(proposed.value)
                if (value === undefined) throw new AcceptanceError({ boundary: "runtime", message: "Generated field cannot represent this candidate" })
                await locator.fill(value)
              }
            }
            const updated = await state()
            const filled = updated.form?.controls.find((field) => field.path === control.path)
            if (updated.form?.operation !== scenario.operation || !filled || !matches(filled, candidate.input)) throw new AcceptanceError({ boundary: "runtime", message: "Generated control did not retain the exact proposed value or operation" })
          }
          epoch++
          offered.clear()
          return undefined
        }
        if (action.kind !== "submit" || action.target !== `submit:${scenario.operation}` || !current.form.controls.every((control) => matches(control, candidate.input))) throw new AcceptanceError({ boundary: "runtime", message: "Submission fields are incomplete or changed" })
        const submit = form.locator("button[data-action='submit']")
        await assertAvailable(submit)
        epoch++
        offered.clear()
        const [response] = await Promise.all([
          page.waitForResponse((response) => {
            if (!isPublicCall(response)) return false
            try { return decodeCall(response.request().postDataJSON()).operation === scenario.operation } catch { return false }
          }, { timeout }),
          submit.click(),
        ])
        const request = decodeCall(response.request().postDataJSON())
        const status = response.status()
        let result: unknown
        let error: string | undefined
        try {
          const body = decodeResult(await responseJson(response))
          result = body.result
          if (!response.ok()) error = JSON.stringify(body.error ?? body)
        } catch (cause) {
          error = `Public response was not a decoded JSON envelope: ${String(cause)}`
        }
        if (canonical(request.input) !== canonical(candidate.input)) error = `Actual submitted payload differs from the candidate${error ? `; ${error}` : ""}`
        try {
          await page.waitForFunction(() => !document.querySelector(".admin-content .admin-notice-loading") && (
            document.querySelector(".admin-content table[data-loaded='true']") ||
            document.querySelector(".admin-operation-result [role='alert']")
          ), undefined, { timeout })
        } catch (cause) {
          error = `${error ? `${error}; ` : ""}UI did not settle after the captured submission: ${String(cause)}`
        }
        return { operation: request.operation, input: request.input, status, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) }
      })
    })
    return BrowserSurface.of({ observe, actions, execute })
  }),
)
