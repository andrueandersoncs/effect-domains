
import { Effect, Schema } from "effect"
import type { AdminPresentation } from "./application-admin.ts"

type JsonSchema = Readonly<Record<string, unknown>>
type SchemaDocument = Readonly<{ schema?: JsonSchema; definitions?: Readonly<Record<string, JsonSchema>>; $defs?: Readonly<Record<string, JsonSchema>> }>
type Operation = Readonly<{ name: string; input: SchemaDocument }>
type Resource = Readonly<{ name: string; operations: ReadonlyArray<string>; storage?: Readonly<{ physical?: Readonly<{ identifier?: string; fields?: ReadonlyArray<Readonly<{ name: string }>> }> }> }>
type Inspection = Readonly<{ application: string; resources: ReadonlyArray<Resource>; operations: ReadonlyArray<Operation> }>
type Metadata = Inspection & Readonly<{ presentation?: AdminPresentation }>

class AdminInputError extends Schema.TaggedError<AdminInputError>()("AdminInputError", {
  message: Schema.String,
}) {}


class AdminRequestError extends Schema.TaggedError<AdminRequestError>()("AdminRequestError", {
  message: Schema.String,
}) {}
type FormControl = Readonly<{ node: HTMLElement; included: () => boolean; value: () => Effect.Effect<unknown, AdminInputError> }>

const root = document.getElementById("app")

if (root) {
  const base = (root.dataset.base || "/admin").replace(/\/$/, "")
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const clear = (node: Element) => node.replaceChildren()
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
  const printable = (value: unknown) => {
    if (value === undefined) return ""
    if (typeof value === "string") return value
    return JSON.stringify(value, null, 2)
  }
  const schemaType = (schema: JsonSchema) => typeof schema.type === "string" ? schema.type : undefined
  const forbidden = (schema: JsonSchema) => record(schema.not) && Object.keys(schema.not).length === 0
  const required = (schema: JsonSchema, field: string) => Array.isArray(schema.required) && schema.required.includes(field)
  const title = (value: string) => value.replace(/[._-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())

  const shell = element("div", "admin-shell")
  const header = element("header", "admin-header")
  const identity = element("div", "admin-identity")
  const appTitle = element("h1")
  const subtitle = element("p", "admin-subtitle")
  identity.append(appTitle, subtitle)
  const token = element("input", "admin-token") as HTMLInputElement
  token.type = "password"
  token.autocomplete = "off"
  token.placeholder = "Bearer token (memory only)"
  token.setAttribute("aria-label", "Bearer authorization token")
  const reload = element("button", "admin-button admin-button-secondary", "Reload") as HTMLButtonElement
  reload.type = "button"
  const connection = element("div", "admin-connection")
  connection.append(token, reload)
  header.append(identity, connection)
  const main = element("main", "admin-main")
  const nav = element("nav", "admin-nav")
  nav.setAttribute("aria-label", "Application navigation")
  const content = element("section", "admin-content")
  content.setAttribute("aria-live", "polite")
  main.append(nav, content)
  shell.append(header, main)
  root.replaceChildren(shell)

  let inspection: Inspection | undefined
  let presentation: AdminPresentation | undefined

  const message = (kind: "error" | "success" | "loading", text: string) => {
    const node = element("div", `admin-notice admin-notice-${kind}`, text)
    node.setAttribute("role", kind === "error" ? "alert" : "status")
    return node
  }
  const operation = (name: string) => inspection?.operations.find((entry) => entry.name === name)
  const resourceLabel = (resource: Resource) => presentation?.resources?.[resource.name]?.label || title(resource.name)
  const operationLabel = (entry: Operation) => presentation?.operations?.[entry.name]?.label || title(entry.name)

  const request = <T,>(path: string, init?: RequestInit) => Effect.gen(function* () {
    const headers = new Headers(init?.headers)
    headers.set("accept", "application/json")
    const credential = token.value.trim()
    if (credential) headers.set("authorization", `Bearer ${credential}`)
    const response = yield* Effect.tryPromise({
      try: () => fetch(`${base}${path}`, { ...init, headers }),
      catch: () => AdminRequestError.make({ message: "Admin request could not be sent." }),
    })
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => AdminRequestError.make({ message: response.statusText || "Admin response was not JSON." }),
    })
    if (!response.ok) return yield* AdminRequestError.make({ message: printable(record(body) && "error" in body ? body.error : body) || `Request failed (${response.status})` })
    return body as T
  })
  const run = (effect: Effect.Effect<void, AdminRequestError | AdminInputError>, onError: (error: AdminRequestError | AdminInputError) => void = (error) => content.replaceChildren(message("error", error.message))) =>
    void Effect.runPromise(Effect.catch(effect, (error) => Effect.sync(() => onError(error))))
  const call = (name: string, input: unknown) => Effect.map(request<{ result: unknown }>("/api/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: name, input }),
  }), (body) => body.result)

  const resolve = (schema: JsonSchema, document: SchemaDocument): JsonSchema => {
    if (typeof schema.$ref !== "string") return schema
    const name = schema.$ref.replace(/^#\/(?:\$defs|definitions)\//, "")
    return (document.$defs || document.definitions || {})[name] || schema
  }
  const optional = (node: HTMLElement, mandatory: boolean, value: () => Effect.Effect<unknown, AdminInputError>): FormControl => {
    if (mandatory) return { node, included: () => true, value }
    const include = element("input") as HTMLInputElement
    include.type = "checkbox"
    include.className = "admin-optional-toggle"
    const label = element("label", "admin-optional")
    const text = document.createTextNode(" Include")
    label.append(include, text)
    node.append(label)
    return { node, included: () => include.checked, value }
  }

  const inputError = (message: string) => AdminInputError.make({ message })

  const parseJson = (source: string, message: string) => Effect.try({
    try: () => JSON.parse(source),
    catch: () => inputError(message),
  })

  const jsonControl = (name: string, initial: unknown, mandatory: boolean): FormControl => {
    const label = element("label", "admin-field admin-field-wide")
    const fieldLabel = element("span", "admin-field-label", name)
    label.append(fieldLabel)
    const input = element("textarea", "admin-json") as HTMLTextAreaElement
    input.rows = 7
    input.value = initial === undefined ? "" : printable(initial)
    input.placeholder = "JSON value"
    input.setAttribute("aria-label", name)
    label.append(input)
    const value = () => input.value.trim()
      ? parseJson(input.value, `${name} must be valid JSON`)
      : Effect.fail(inputError(`${name} requires JSON`))
    return optional(label, mandatory, value)
  }

  const scalarControl = (name: string, schema: JsonSchema, initial: unknown, mandatory: boolean): FormControl => {
    const label = element("label", "admin-field")
    const fieldLabel = element("span", "admin-field-label", name)
    label.append(fieldLabel)
    const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined
    if (enumValues) {
      const input = element("select", "admin-input") as HTMLSelectElement
      input.setAttribute("aria-label", name)
      if (!mandatory) {
        const empty = new Option("Select a value", "")
        input.append(empty)
      }
      for (const choice of enumValues) {
        const option = new Option(String(choice), JSON.stringify(choice))
        input.append(option)
      }
      if (initial !== undefined) input.value = JSON.stringify(initial)
      label.append(input)
      const value = () => input.value ? parseJson(input.value, `${name} must be valid JSON`) : Effect.fail(inputError(`${name} is required`))
      return optional(label, mandatory, value)
    }
    if (schemaType(schema) === "boolean") {
      const input = element("input") as HTMLInputElement
      input.type = "checkbox"
      input.checked = initial === true
      input.setAttribute("aria-label", name)
      label.append(input)
      return optional(label, mandatory, () => Effect.succeed(input.checked))
    }
    const input = element("input", "admin-input") as HTMLInputElement
    const type = schemaType(schema)
    const numeric = type === "number" || type === "integer"
    input.type = numeric ? "number" : "text"
    input.step = type === "integer" ? "1" : "any"
    input.value = initial === undefined || initial === null ? "" : String(initial)
    input.setAttribute("aria-label", name)
    label.append(input)
    const value = () => {
      if (!numeric) return Effect.succeed(input.value)
      if (!input.value) return Effect.fail(inputError(`${name} is required`))
      const number = Number(input.value)
      const finite = Number.isFinite(number)
      const integral = type === "integer" ? Number.isInteger(number) : true
      return finite && integral ? Effect.succeed(number) : Effect.fail(inputError(`${name} must be a ${type}`))
    }
    return optional(label, mandatory, value)
  }
  const formControl = (name: string, raw: JsonSchema, document: SchemaDocument, mandatory: boolean, initial?: unknown, ancestors: ReadonlySet<JsonSchema> = new Set()): FormControl | undefined => {
    const schema = resolve(raw, document)
    if (forbidden(schema)) return undefined
    const type = schemaType(schema)
    if (type === "object" && record(schema.properties)) {
      if (ancestors.has(schema)) return jsonControl(name, initial, mandatory)
      const fieldset = element("fieldset", "admin-fieldset")
      fieldset.append(element("legend", undefined, name))
      const fields = element("div", "admin-fields")
      const controls: Array<readonly [string, FormControl]> = []
      const nested = new Set(ancestors)
      nested.add(schema)
      for (const [key, child] of Object.entries(schema.properties)) {
        if (!record(child)) continue
        const control = formControl(key, child, document, required(schema, key), record(initial) ? initial[key] : undefined, nested)
        if (control) { controls.push([key, control]); fields.append(control.node) }
      }
      fieldset.append(fields)
      const value = () => Effect.suspend(() => {
        const selected = controls.filter((entry) => entry[1].included())
        const values = Effect.forEach(selected, ([key, control]) => Effect.map(control.value(), (value) => [key, value] as const))
        return Effect.map(values, (entries) => Object.fromEntries(entries))
      })
      return optional(fieldset, mandatory, value)
    }
    if (type === "null") return jsonControl(name, initial === undefined ? null : initial, mandatory)
    if (type === "array" || schema.anyOf || schema.oneOf || schema.allOf || schema.const !== undefined || !type) return jsonControl(name, initial, mandatory)
    return scalarControl(name, schema, initial, mandatory)
  }
  const generatedForm = (entry: Operation, initial?: unknown) => {
    const document = entry.input || {}
    const schema = resolve(document.schema || {}, document)
    const form = element("form", "admin-form")
    const fields = element("div", "admin-fields")
    const controls: Array<readonly [string, FormControl]> = []
    if (schemaType(schema) === "object" && record(schema.properties)) {
      for (const [name, property] of Object.entries(schema.properties)) {
        if (!record(property)) continue
        const control = formControl(name, property, document, required(schema, name), record(initial) ? initial[name] : undefined)
        if (control) { controls.push([name, control]); fields.append(control.node) }
      }
    } else {
      const control = formControl("Input", schema, document, true, initial)
      if (control) { controls.push(["$value", control]); fields.append(control.node) }
    }
    const whole = element("textarea", "admin-json") as HTMLTextAreaElement
    whole.rows = 8
    whole.placeholder = "Optional complete JSON payload"
    whole.setAttribute("aria-label", "Complete JSON payload")
    const fallback = element("details", "admin-json-fallback")
    fallback.append(element("summary", undefined, "Edit entire input as JSON"), whole)
    const submit = element("button", "admin-button admin-button-primary", "Run") as HTMLButtonElement
    submit.type = "submit"
    form.append(fields, fallback, submit)
    return {
      form,
      submit,
      input: () => {
        if (whole.value.trim()) return parseJson(whole.value, "Complete JSON payload must be valid JSON")
        const objectInput = schemaType(schema) === "object" && record(schema.properties)
        if (!objectInput) {
          const control = controls[0]
          return control ? control[1].value() : Effect.succeed(undefined)
        }
        const selected = controls.filter((entry) => entry[1].included())
        const values = Effect.forEach(selected, ([name, control]) => Effect.map(control.value(), (value) => [name, value] as const))
        return Effect.map(values, (entries) => Object.fromEntries(entries))
      },
    }
  }
  const showResult = (value: unknown) => {
    const result = element("pre", "admin-result")
    result.textContent = printable(value === undefined ? null : value)
    return result
  }

  const renderOperation = (entry: Operation, resource?: Resource) => {
    clear(content)
    content.append(element("h2", undefined, operationLabel(entry)))
    const description = presentation?.operations?.[entry.name]?.description
    if (description) content.append(element("p", "admin-description", description))
    const generated = generatedForm(entry)
    const result = element("div", "admin-operation-result")
    generated.form.addEventListener("submit", (event) => {
      event.preventDefault()
      const workflow = Effect.gen(function* () {
        const input = yield* generated.input()
        generated.submit.disabled = true
        result.replaceChildren(message("loading", "Calling operation…"))
        const value = yield* call(entry.name, input)
        result.replaceChildren(message("success", "Operation completed."), showResult(value))
        generated.submit.disabled = false
        const action = entry.name.split(".").at(-1)
        if (resource && action && ["create", "update", "patch", "remove"].includes(action) && resource.operations.includes("list")) renderList(resource)
      })
      run(workflow, (error) => {
        generated.submit.disabled = false
        result.replaceChildren(message("error", error.message))
      })
    })
    content.append(generated.form, result)
  }

  const renderList = (resource: Resource) => {
    const entry = operation(`${resource.name}.list`)
    if (!entry) return
    clear(content)
    content.append(element("h2", undefined, resourceLabel(resource)))
    const input = resolve(entry.input.schema || {}, entry.input)
    const inputProperties = record(input.properties) ? input.properties : {}
    const rawFilter = record(inputProperties.filter) ? resolve(inputProperties.filter, entry.input) : undefined
    const filterProperties = rawFilter && record(rawFilter.properties) ? rawFilter.properties : {}
    const filterForm = element("form", "admin-filter-form")
    const fields = element("div", "admin-fields")
    const filters: Array<readonly [string, FormControl]> = []
    for (const [name, schema] of Object.entries(filterProperties)) {
      if (!record(schema)) continue
      const control = formControl(name, schema, entry.input, false)
      if (control) { filters.push([name, control]); fields.append(control.node) }
    }
    const hasLimit = Object.hasOwn(inputProperties, "limit")
    const hasCursor = Object.hasOwn(inputProperties, "cursor")
    const limit = element("input", "admin-input admin-limit") as HTMLInputElement
    limit.type = "number"; limit.min = "1"; limit.step = "1"; limit.placeholder = "Limit"; limit.setAttribute("aria-label", "List limit")
    const apply = element("button", "admin-button admin-button-secondary", "Apply") as HTMLButtonElement
    apply.type = "submit"
    filterForm.append(fields)
    if (hasLimit) filterForm.append(limit)
    filterForm.append(apply)
    const result = element("div", "admin-list-result")
    content.append(filterForm, result)
    const loadPage = (cursor?: string, history: ReadonlyArray<string | undefined> = []) => {
      apply.disabled = true
      result.replaceChildren(message("loading", "Loading rows…"))
      const workflow = Effect.gen(function* () {
        const selected = filters.filter((filter) => filter[1].included())
        const entries = yield* Effect.forEach(selected, ([name, control]) => Effect.map(control.value(), (value) => [name, value] as const))
        const filter = Object.fromEntries(entries)
        const withFilter = Object.keys(filter).length ? { filter } : {}
        const withLimit = hasLimit && limit.value ? { limit: Number(limit.value) } : {}
        const withCursor = hasCursor && cursor !== undefined ? { cursor } : {}
        const payload = { ...withFilter, ...withLimit, ...withCursor }
        const value = yield* call(entry.name, payload)
        const page = Array.isArray(value) ? { items: value, nextCursor: undefined } : record(value) && Array.isArray(value.items) ? { items: value.items, nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : undefined } : { items: [], nextCursor: undefined }
        const columns = presentation?.resources?.[resource.name]?.columns || resource.storage?.physical?.fields?.map((field) => field.name) || Array.from(new Set(page.items.flatMap((row) => record(row) ? Object.keys(row) : [])))
        const table = element("table", "admin-table")
        const tableHead = element("thead"); const headerRow = element("tr")
        for (const column of columns) headerRow.append(element("th", undefined, column))
        tableHead.append(headerRow); table.append(tableHead)
        const body = element("tbody")
        for (const row of page.items) {
          const tableRow = element("tr")
          for (const column of columns) tableRow.append(element("td", undefined, record(row) ? printable(row[column]) : printable(row)))
          body.append(tableRow)
        }
        table.append(body)
        if (hasCursor) {
          const paging = element("div", "admin-paging")
          const back = element("button", "admin-button admin-button-secondary", "Back") as HTMLButtonElement
          back.type = "button"; back.disabled = history.length === 0
          back.addEventListener("click", () => loadPage(history.at(-1), history.slice(0, -1)))
          const next = element("button", "admin-button admin-button-secondary", "Next") as HTMLButtonElement
          next.type = "button"; next.disabled = !page.nextCursor
          next.addEventListener("click", () => loadPage(page.nextCursor, [...history, cursor]))
          paging.append(back, next)
          result.replaceChildren(table, paging)
        } else result.replaceChildren(table)
        apply.disabled = false
      })
      run(workflow, (error) => {
        apply.disabled = false
        result.replaceChildren(message("error", error.message))
      })
    }
    filterForm.addEventListener("submit", (event) => { event.preventDefault(); loadPage() })
    loadPage()
  }

  const renderNavigation = () => {
    clear(nav)
    if (!inspection) return
    const resources = element("div", "admin-nav-group")
    resources.append(element("h2", "admin-nav-title", "Resources"))
    for (const resource of inspection.resources) {
      const resourceButton = element("button", "admin-nav-resource", resourceLabel(resource)) as HTMLButtonElement
      resourceButton.type = "button"
      resourceButton.addEventListener("click", () => {
        if (resource.operations.includes("list")) return renderList(resource)
        const entry = resource.operations.map((name) => operation(`${resource.name}.${name}`)).find((candidate): candidate is Operation => candidate !== undefined)
        if (entry) renderOperation(entry, resource)
      })
      resources.append(resourceButton)
      const operations = element("div", "admin-nav-operations")
      for (const name of resource.operations) {
        const entry = operation(`${resource.name}.${name}`)
        if (!entry) continue
        const button = element("button", "admin-nav-operation", presentation?.operations?.[entry.name]?.label || name) as HTMLButtonElement
        button.type = "button"
        button.addEventListener("click", () => name === "list" ? renderList(resource) : renderOperation(entry, resource))
        operations.append(button)
      }
      resources.append(operations)
    }
    nav.append(resources)
    const names = new Set(inspection.resources.flatMap((resource) => resource.operations.map((name) => `${resource.name}.${name}`)))
    const commands = inspection.operations.filter((entry) => !names.has(entry.name))
    if (commands.length) {
      const group = element("div", "admin-nav-group")
      group.append(element("h2", "admin-nav-title", "Commands"))
      for (const entry of commands) {
        const button = element("button", "admin-nav-resource", operationLabel(entry)) as HTMLButtonElement
        button.type = "button"; button.addEventListener("click", () => renderOperation(entry)); group.append(button)
      }
      nav.append(group)
    }
  }
  const load = () => run(Effect.gen(function* () {
    content.replaceChildren(message("loading", "Loading application metadata…"))
    const metadata = yield* request<Metadata>("/api")
    inspection = metadata
    presentation = metadata.presentation
    appTitle.textContent = presentation?.title || inspection.application
    subtitle.textContent = "Generated application admin"
    renderNavigation()
    const first = inspection.resources.find((resource) => resource.operations.includes("list"))
    if (first) renderList(first)
    else if (inspection.operations[0]) renderOperation(inspection.operations[0])
    else content.replaceChildren(message("error", "The application has no published operations."))
  }))
  reload.addEventListener("click", load)
  load()
}
