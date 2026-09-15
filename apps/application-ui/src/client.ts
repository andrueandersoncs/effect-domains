import {
  Array,
  Effect,
  Equivalence,
  Function,
  HashSet,
  Match,
  Option,
  Predicate,
  Record,
  Ref,
  Schema,
  Struct,
  flow,
  pipe,
} from "effect"

import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { ApplicationUiPresentation } from "./contract.ts"

const JsonSchema = Schema.Record(Schema.String, Schema.Unknown)
const JsonArraySchema = Schema.Array(Schema.Unknown)
const FieldSchema = Schema.Struct({ name: Schema.String })
interface Field extends Schema.Schema.Type<typeof FieldSchema> {}

const PhysicalStorageSchema = Schema.Struct({ identifier: Schema.optionalKey(Schema.String), fields: Schema.optionalKey(Schema.Array(FieldSchema)) })
interface PhysicalStorage extends Schema.Schema.Type<typeof PhysicalStorageSchema> {}

const StorageSchema = Schema.Struct({ physical: Schema.optionalKey(PhysicalStorageSchema) })
interface Storage extends Schema.Schema.Type<typeof StorageSchema> {}

const SchemaDocumentSchema = Schema.Struct({ schema: Schema.optionalKey(JsonSchema), definitions: Schema.optionalKey(Schema.Record(Schema.String, JsonSchema)), $defs: Schema.optionalKey(Schema.Record(Schema.String, JsonSchema)) })
interface SchemaDocument extends Schema.Schema.Type<typeof SchemaDocumentSchema> {}

const OperationSchema = Schema.Struct({ name: Schema.String, input: SchemaDocumentSchema })
interface Operation extends Schema.Schema.Type<typeof OperationSchema> {}

const ResourceSchema = Schema.Struct({ name: Schema.String, operations: Schema.Array(Schema.String), storage: Schema.optionalKey(StorageSchema) })
interface Resource extends Schema.Schema.Type<typeof ResourceSchema> {}

const InspectionSchema = Schema.Struct({ application: Schema.String, resources: Schema.Array(ResourceSchema), operations: Schema.Array(OperationSchema) })
interface Inspection extends Schema.Schema.Type<typeof InspectionSchema> {}


const ResourcePresentationSchema = Schema.Struct({ label: Schema.optionalKey(Schema.String), columns: Schema.optionalKey(Schema.Array(Schema.String)) })
interface ResourcePresentation extends Schema.Schema.Type<typeof ResourcePresentationSchema> {}

const OperationPresentationSchema = Schema.Struct({ label: Schema.optionalKey(Schema.String), description: Schema.optionalKey(Schema.String) })
interface OperationPresentation extends Schema.Schema.Type<typeof OperationPresentationSchema> {}

const PresentationSchema = Schema.Struct({ title: Schema.optionalKey(Schema.String), description: Schema.optionalKey(Schema.String), resources: Schema.optionalKey(Schema.Record(Schema.String, ResourcePresentationSchema)), operations: Schema.optionalKey(Schema.Record(Schema.String, OperationPresentationSchema)) })
interface Presentation extends Schema.Schema.Type<typeof PresentationSchema> {}

const MetadataSchema = Schema.Struct({ application: Schema.String, resources: Schema.Array(ResourceSchema), operations: Schema.Array(OperationSchema), presentation: Schema.optionalKey(PresentationSchema) })
interface Metadata extends Schema.Schema.Type<typeof MetadataSchema> {}

const PageSchema = Schema.Struct({ items: JsonArraySchema, nextCursor: Schema.Option(Schema.String) })
interface Page extends Schema.Schema.Type<typeof PageSchema> {}

const emptyPage = PageSchema.make({ items: [], nextCursor: Option.none() })
const noPage = Function.constant(emptyPage)
const ClientStateSchema = Schema.Struct({ inspection: Schema.Option(InspectionSchema), presentation: Schema.Option(PresentationSchema) })
interface ClientState extends Schema.Schema.Type<typeof ClientStateSchema> {}

const CallInputSchema = Schema.Struct({ operation: Schema.String, input: Schema.Unknown })
interface CallInput extends Schema.Schema.Type<typeof CallInputSchema> {}

interface JsonSchema extends Schema.Schema.Type<typeof JsonSchema> {}

const IncludedSchema = Schema.declare<() => boolean>(Predicate.isFunction as Predicate.Refinement<unknown, () => boolean>)
const FormValueSchema = Schema.declare<() => Effect.Effect<unknown, ApplicationUiInputError>>(Predicate.isFunction as Predicate.Refinement<unknown, () => Effect.Effect<unknown, ApplicationUiInputError>>)

const FormControlSchema = Schema.Struct({
  node: Schema.instanceOf(HTMLElement),
  included: IncludedSchema,
  value: FormValueSchema,
})

interface FormControl extends Schema.Schema.Type<typeof FormControlSchema> {}

class FormEntry extends Schema.Class<FormEntry>("FormEntry")({
  name: Schema.String,
  control: FormControlSchema,
}) {}

class ApplicationUiInputError extends Schema.TaggedError<ApplicationUiInputError>()("ApplicationUiInputError", {
  message: Schema.String,
}) {}

class ApplicationUiRequestError extends Schema.TaggedError<ApplicationUiRequestError>()("ApplicationUiRequestError", {
  message: Schema.String,
}) {}

const equals = Equivalence.strictEqual<unknown>()
const emptyUnknownArray = Function.constant<ReadonlyArray<unknown>>([])
const emptyOperation = Option.none<Operation>()
const absentOperation = Effect.succeed(emptyOperation)
const noOperation = Function.constant(absentOperation)
const noEffect = Function.constant(Effect.void)
const isRecords = Schema.is(JsonSchema)
const isJsonSchema = Schema.is(JsonSchema)
const isString = Schema.is(Schema.String)
const isJsonArray = Schema.is(JsonArraySchema)
const uppercase = (letter: string) => letter.toUpperCase()
const title = (value: string) => value.replace(/[._-]/g, " ").replace(/\b\w/g, uppercase)

const textFor = (value: unknown) => {
  if (isString(value)) return value
  const serialized = JSON.stringify(value, null, 2)
  return pipe(Option.fromUndefinedOr(serialized), Option.getOrElse(Function.constant("")))
}

const absentValue = Option.none<unknown>()
const noResource = Option.none<Resource>()
const noCursor = Option.none<string>()
const noAncestors = HashSet.empty<JsonSchema>()
const presentationResources = (presentation: ApplicationUiPresentation) => Option.fromUndefinedOr(presentation.resources)
const presentationOperations = (presentation: ApplicationUiPresentation) => Option.fromUndefinedOr(presentation.operations)
const valueAtKey = <Value>(record: Readonly<Record<string, Value>>, key: string) => Record.get(record, key)

const documentDefinitions = (document: SchemaDocument) => {
  const definitions = Option.fromUndefinedOr(document.definitions)
  const fallback = () => Option.fromUndefinedOr(document.$defs)
  const definitionsOrDefs = pipe(definitions, Option.orElse(fallback))
  const emptyDefinitions = Record.empty<string, JsonSchema>()
  return pipe(definitionsOrDefs, Option.getOrElse(Function.constant(emptyDefinitions)))
}

const resolveSchema = (schema: JsonSchema, document: SchemaDocument) => {
  const reference = Option.fromUndefinedOr(schema.$ref)
  const resolved = pipe(reference, Option.filter(isString))

  return Option.match(resolved, {
    onNone: Function.constant(schema),
    onSome: (value) => {
      const name = value.replace(/^#\/(?:\$defs|definitions)\//, "")
      const definitions = documentDefinitions(document)
      const defined = valueAtKey(definitions, name)
      return pipe(defined, Option.getOrElse(Function.constant(schema)))
    },
  })
}

const pipeOptionString = flow(Option.fromNullishOr, Option.filter(isString))
const schemaType = (schema: JsonSchema) => pipeOptionString(schema.type)

const hasEmptyNot = (schema: JsonSchema) => {
  const not = Option.fromNullishOr(schema.not)
  const forbidden = pipe(not, Option.filter(isRecords))
  return Option.exists(forbidden, Record.isEmptyReadonlyRecord)
}

const isRequired = (schema: JsonSchema, field: string) => {
  const candidate = Option.fromNullishOr(schema.required)
  const required = pipe(candidate, Option.filter(isJsonArray))
  const includes = (fields: ReadonlyArray<unknown>) => Array.contains(fields, field)
  return Option.exists(required, includes)
}

const fieldValue = (record: Readonly<Record<string, unknown>>, key: string) => Option.fromUndefinedOr(record[key])

const entryValue = Effect.fn("ApplicationUi.form.entryValue")(function* ({ name: name, control: control }: FormEntry) { const value = yield* control.value()
return [name, value] as const })

const selectedEntry = ({ control: control }: FormEntry) => control.included()
const root = document.getElementById("app")

const mount = Effect.fn("ApplicationUi.mount")(function* (root: HTMLElement) {
  const configuredBase = Option.fromUndefinedOr(root.dataset.base)
  const base = pipe(configuredBase, Option.getOrElse(Function.constant("/"))).replace(/\/$/, "")

  const element = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: Option.Option<string>, text: Option.Option<string>) => {
    const node = document.createElement(tag)

    Option.match(className, {
      onNone: Function.constant(node),
      onSome: (value) => {
        node.className = value
        return node
      },
    })

    Option.match(text, {
      onNone: Function.constant(node),
      onSome: (value) => {
        node.textContent = value
        return node
      },
    })

    return node
  }

  const namedElement = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, text: string) => {
    const classes = Option.some(className)
    const content = Option.some(text)
    return element(tag, classes, content)
  }

  const emptyElement = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag) => {
    const noClass = Option.none<string>()
    const noText = Option.none<string>()
    return element(tag, noClass, noText)
  }

  const clear = (node: Element) => {
    node.replaceChildren()
    return node
  }

  const notice = (kind: "error" | "success" | "loading", text: string) => {
    const node = namedElement("div", `admin-notice admin-notice-${kind}`, text)
    const error = equals(kind, "error")
    node.setAttribute("role", error ? "alert" : "status")
    return node
  }

  const shell = namedElement("div", "admin-shell", "")
  const header = namedElement("header", "admin-header", "")
  const identity = namedElement("div", "admin-identity", "")
  const applicationTitle = emptyElement("h1")
  const subtitle = namedElement("p", "admin-subtitle", "")
  identity.append(applicationTitle, subtitle)
  const token = namedElement("input", "admin-token", "") as HTMLInputElement
  token.type = "password"
  token.autocomplete = "off"
  token.placeholder = "Bearer token (memory only)"
  token.setAttribute("aria-label", "Bearer authorization token")
  const reload = namedElement("button", "admin-button admin-button-secondary", "Reload") as HTMLButtonElement
  reload.type = "button"
  const connection = namedElement("div", "admin-connection", "")
  connection.append(token, reload)
  header.append(identity, connection)
  const main = namedElement("main", "admin-main", "")
  const navigation = namedElement("nav", "admin-nav", "")
  navigation.setAttribute("aria-label", "Application navigation")
  const content = namedElement("section", "admin-content", "")
  content.setAttribute("aria-live", "polite")
  main.append(navigation, content)
  shell.append(header, main)
  root.replaceChildren(shell)

  const initialState = ClientStateSchema.make({
    inspection: Option.none(),
    presentation: Option.none(),
  })

  const state = yield* Ref.make(initialState)
  const unavailableError = ApplicationUiRequestError.make({ message: "Application UI request could not be sent." })
  const invalidJsonError = ApplicationUiRequestError.make({ message: "Application UI response was not JSON." })
  const requestUnavailable = pipe(Effect.fail(unavailableError), Function.constant)
  const responseWasNotJson = pipe(Effect.fail(invalidJsonError), Function.constant)

  const requestJson = Effect.fn("ApplicationUi.request")(function* (request: HttpClientRequest.HttpClientRequest) {
    const executed = HttpClient.execute(request)
    const response = yield* Effect.catch(executed, requestUnavailable)
    const body = yield* Effect.catch(response.json, responseWasNotJson)
    const lower = response.status >= 200
    const upper = response.status < 300
    const success = lower && upper

    if (!success) {
      const failure = isRecords(body) ? fieldValue(body, "error") : Option.none<unknown>()
      const bodyError = isRecords(body) ? pipe(failure, Option.getOrElse(Function.constant(body))) : body
      const rendered = textFor(bodyError)
      const detail = rendered || `Request failed (${response.status})`
      return yield* ApplicationUiRequestError.make({ message: detail })
    }

    return body
  })

  const withAuthorization = (request: HttpClientRequest.HttpClientRequest) => {
    const credential = token.value.trim()
    const authorized = Boolean(credential)
    return authorized ? HttpClientRequest.bearerToken(request, credential) : request
  }

  const getJson = Effect.fn("ApplicationUi.get")(function* (path: string) {
    const url = `${base}${path}`
    const get = HttpClientRequest.get(url)
    const request = HttpClientRequest.acceptJson(get)
    const authorized = withAuthorization(request)
    return yield* requestJson(authorized)
  })

  const postJson = Effect.fn("ApplicationUi.post")(function* (path: string, payload: unknown) {
    const url = `${base}${path}`
    const post = HttpClientRequest.post(url)
    const accepted = HttpClientRequest.acceptJson(post)
    const body = HttpClientRequest.bodyJson(accepted, payload)
    const bodyFailure = pipe(ApplicationUiRequestError.make({ message: "Application UI request body could not be encoded." }), Function.constant)
    const request = yield* Effect.mapError(body, bodyFailure)
    const authorized = withAuthorization(request)
    return yield* requestJson(authorized)
  })

  const call = Effect.fn("ApplicationUi.call")(function* (name: string, input: unknown) {
    const payload = CallInputSchema.make({ operation: name, input })
    const response = yield* postJson("/api/call", payload)
    const record = isRecords(response) ? response : Record.empty<string, unknown>()
    const result = pipe(fieldValue(record, "result"), Option.getOrElse(Function.constant(null)))
    return result
  })

  const lookupOperation = Effect.fn("ApplicationUi.lookupOperation")(function* (name: string) {
    const current = yield* Ref.get(state)
    const matching = (entry: Operation) => equals(entry.name, name)
    const found = pipe(current.inspection, Option.flatMap(flow(Struct.get("operations"), Array.findFirst(matching))))
    return found
  })

  const currentPresentation = Effect.fn("ApplicationUi.currentPresentation")(function* () {
    const current = yield* Ref.get(state)
    return current.presentation
  })

  const resourcePresentation = Effect.fn("ApplicationUi.resourcePresentation")(function* (resource: Resource) {
    const presentation = yield* currentPresentation()
    const resources = pipe(presentation, Option.flatMap(presentationResources))
    return pipe(resources, Option.flatMap((values) => valueAtKey(values, resource.name)))
  })

  const operationPresentation = Effect.fn("ApplicationUi.operationPresentation")(function* (operation: Operation) {
    const presentation = yield* currentPresentation()
    const operations = pipe(presentation, Option.flatMap(presentationOperations))
    return pipe(operations, Option.flatMap((values) => valueAtKey(values, operation.name)))
  })

  const resourceLabel = Effect.fn("ApplicationUi.resourceLabel")(function* (resource: Resource) {
    const presentation = yield* resourcePresentation(resource)
    const label = pipe(presentation, Option.flatMap(flow(Struct.get("label"), Option.fromUndefinedOr)))
    const fallback = title(resource.name)
    return pipe(label, Option.getOrElse(Function.constant(fallback)))
  })

  const operationLabel = Effect.fn("ApplicationUi.operationLabel")(function* (operation: Operation) {
    const presentation = yield* operationPresentation(operation)
    const label = pipe(presentation, Option.flatMap(flow(Struct.get("label"), Option.fromUndefinedOr)))
    const fallback = title(operation.name)
    return pipe(label, Option.getOrElse(Function.constant(fallback)))
  })

  const inputError = (message: string) => ApplicationUiInputError.make({ message })
  const parseJson = (source: string, message: string) => Effect.try({ try: () => JSON.parse(source), catch: () => inputError(message) })

  const inclusionControl = (node: HTMLElement, mandatory: boolean, value: () => Effect.Effect<unknown, ApplicationUiInputError>): FormControl => {
    if (mandatory) return { node, included: Function.constant(true), value }
    const include = emptyElement("input") as HTMLInputElement
    include.type = "checkbox"
    include.className = "admin-optional-toggle"
    const label = namedElement("label", "admin-optional", "")
    const text = document.createTextNode(" Include")
    label.append(include, text)
    node.append(label)
    const included = () => include.checked
    return { node, included, value }
  }

  const jsonControl = (name: string, initial: Option.Option<unknown>, mandatory: boolean): FormControl => {
    const label = namedElement("label", "admin-field admin-field-wide", "")
    const fieldLabel = namedElement("span", "admin-field-label", name)
    label.append(fieldLabel)
    const input = namedElement("textarea", "admin-json", "") as HTMLTextAreaElement
    input.rows = 7
    input.value = Option.match(initial, { onNone: Function.constant(""), onSome: textFor })
    input.placeholder = "JSON value"
    input.setAttribute("aria-label", name)
    label.append(input)

    const value = () => {
      const source = input.value.trim()
      const populated = Boolean(source)
      return populated ? parseJson(input.value, `${name} must be valid JSON`) : pipe(inputError(`${name} requires JSON`), Effect.fail)
    }

    return inclusionControl(label, mandatory, value)
  }

  const scalarControl = (name: string, schema: JsonSchema, initial: Option.Option<unknown>, mandatory: boolean): FormControl => {
    const label = namedElement("label", "admin-field", "")
    const fieldLabel = namedElement("span", "admin-field-label", name)
    label.append(fieldLabel)
    const enums = pipe(Option.fromNullishOr(schema.enum), Option.filter(isJsonArray))

    return Option.match(enums, {
      onSome: (values) => {
        const input = namedElement("select", "admin-input", "") as HTMLSelectElement
        input.setAttribute("aria-label", name)

        if (!mandatory) {
          const empty = new globalThis.Option("Select a value", "")
          input.append(empty)
        }

        const appendChoice = (choice: unknown) => {
          const label = String(choice)
          const encoded = JSON.stringify(choice)
          const option = new globalThis.Option(label, encoded)
          input.append(option)
          return option
        }

        Array.forEach(values, appendChoice)

        Option.match(initial, {
          onNone: Function.constant(input),
          onSome: (value) => {
            input.value = JSON.stringify(value)
            return input
          },
        })

        label.append(input)

        const value = () => {
          const selected = input.value.trim()
          return selected ? parseJson(selected, `${name} must be valid JSON`) : pipe(inputError(`${name} is required`), Effect.fail)
        }

        return inclusionControl(label, mandatory, value)
      },
      onNone: () => {
        const type = schemaType(schema)
        const boolean = pipe(type, Option.contains("boolean"))

        if (boolean) {
          const input = emptyElement("input") as HTMLInputElement
          input.type = "checkbox"
          input.checked = pipe(initial, Option.contains<unknown>(true))
          input.setAttribute("aria-label", name)
          label.append(input)
          const value = () => Effect.succeed(input.checked)
          return inclusionControl(label, mandatory, value)
        }

        const input = namedElement("input", "admin-input", "") as HTMLInputElement
        const integer = pipe(type, Option.contains("integer"))
        const number = pipe(type, Option.contains("number"))
        const numeric = number || integer
        input.type = numeric ? "number" : "text"
        input.step = integer ? "1" : "any"
        input.value = Option.match(initial, { onNone: Function.constant(""), onSome: (value) => equals(value, null) ? "" : String(value) })
        input.setAttribute("aria-label", name)
        label.append(input)

        const value = () => {
          if (!numeric) return Effect.succeed(input.value)
          const raw = input.value.trim()
          if (!raw) return pipe(inputError(`${name} is required`), Effect.fail)
          const parsed = Number(raw)
          const finite = Number.isFinite(parsed)
          const integral = integer ? Number.isInteger(parsed) : true
          const valid = finite && integral
          const expected = pipe(type, Option.getOrElse(Function.constant("number")))
          return valid ? Effect.succeed(parsed) : pipe(inputError(`${name} must be a ${expected}`), Effect.fail)
        }

        return inclusionControl(label, mandatory, value)
      },
    })
  }

  const formControl = (name: string, raw: JsonSchema, document: SchemaDocument, mandatory: boolean, initial: Option.Option<unknown>, ancestors: HashSet.HashSet<JsonSchema>): Option.Option<FormControl> => {
    const schema = resolveSchema(raw, document)
    if (hasEmptyNot(schema)) return Option.none()
    const type = schemaType(schema)
    const object = pipe(type, Option.contains("object"))
    const properties = pipe(Option.fromNullishOr(schema.properties), Option.filter(isRecords))
    const objectWithProperties = object && Option.isSome(properties)
    const circular = HashSet.has(ancestors, schema)
    const recursiveObject = objectWithProperties && circular
    if (recursiveObject) return pipe(jsonControl(name, initial, mandatory), Option.some)

    if (objectWithProperties) {
      const fieldset = namedElement("fieldset", "admin-fieldset", "")
      const legend = namedElement("legend", "", name)
      fieldset.append(legend)
      const fields = namedElement("div", "admin-fields", "")
      const nested = HashSet.add(ancestors, schema)
      const children = pipe(properties, Option.getOrElse(Record.empty<string, unknown>))
      const entries = Record.toEntries(children)

      const controlFor = ([key, child]: readonly [string, unknown]) => {
        const childSchema = pipe(Option.some(child), Option.filter(isJsonSchema))
        const childInitial = pipe(initial, Option.filter(isRecords), Option.flatMap(Record.get(key)))
        const required = isRequired(schema, key)
        const control = pipe(childSchema, Option.flatMap((value) => formControl(key, value, document, required, childInitial, nested)))
        const named = (control: FormControl) => FormEntry.make({ name: key, control })
        return pipe(control, Option.map(named))
      }

      const controls = pipe(entries, Array.map(controlFor), Array.getSomes)

      const appendControl = ({ control: control }: FormEntry) => {
        fields.append(control.node)
        return control
      }

      Array.forEach(controls, appendControl)
      fieldset.append(fields)

      const value = () => Effect.suspend(() => {
        const selected = Array.filter(controls, selectedEntry)
        const entries = Effect.forEach(selected, entryValue)
        return Effect.map(entries, Record.fromEntries)
      })

      return pipe(inclusionControl(fieldset, mandatory, value), Option.some)
    }

    const nullType = pipe(type, Option.contains("null"))
    const arrayType = pipe(type, Option.contains("array"))
    const anyOf = pipe(Option.fromNullishOr(schema.anyOf), Option.isSome)
    const oneOf = pipe(Option.fromNullishOr(schema.oneOf), Option.isSome)
    const allOf = pipe(Option.fromNullishOr(schema.allOf), Option.isSome)
    const constant = pipe(Option.fromUndefinedOr(schema.const), Option.isSome)
    const absent = Option.isNone(type)
    const json = Array.some([nullType, arrayType, anyOf, oneOf, allOf, constant, absent], Function.identity)
    return json ? pipe(jsonControl(name, initial, mandatory), Option.some) : pipe(scalarControl(name, schema, initial, mandatory), Option.some)
  }

  const generatedForm = (entry: Operation, initial: Option.Option<unknown>) => {
    const rawSchema = pipe(Option.fromUndefinedOr(entry.input.schema), Option.getOrElse(Record.empty<string, unknown>))
    const schema = resolveSchema(rawSchema, entry.input)
    const form = namedElement("form", "admin-form", "")
    const fields = namedElement("div", "admin-fields", "")
    const object = pipe(schemaType(schema), Option.contains("object"))
    const properties = pipe(Option.fromNullishOr(schema.properties), Option.filter(isRecords))
    const objectInput = object && Option.isSome(properties)
    const noInput = pipe(schemaType(schema), Option.contains("null"))

    const controls = pipe(Match.value(objectInput),
      Match.when(true, () => {
        const values = pipe(properties, Option.getOrElse(Record.empty<string, unknown>))
        const entries = Record.toEntries(values)

        const controlFor = ([name, property]: readonly [string, unknown]) => {
          const propertySchema = pipe(Option.some(property), Option.filter(isJsonSchema))
          const propertyInitial = pipe(initial, Option.filter(isRecords), Option.flatMap(Record.get(name)))
          const required = isRequired(schema, name)
          const control = pipe(propertySchema, Option.flatMap((value) => formControl(name, value, entry.input, required, propertyInitial, noAncestors)))
          const named = (control: FormControl) => FormEntry.make({ name, control })
          return pipe(control, Option.map(named))
        }

        return pipe(entries, Array.map(controlFor), Array.getSomes)
      }),
      Match.when(false, () => {
        if (noInput) return []
        const control = formControl("Input", schema, entry.input, true, initial, noAncestors)
        return Option.match(control, { onNone: Function.constant([]), onSome: (value) => [FormEntry.make({name: "$value", control: value})] })
      }),
      Match.exhaustive,
    )

    const appendControl = ({ control: control }: FormEntry) => {
      fields.append(control.node)
      return control
    }

    Array.forEach(controls, appendControl)
    const whole = namedElement("textarea", "admin-json", "") as HTMLTextAreaElement
    whole.rows = 8
    whole.placeholder = "Optional complete JSON payload"
    whole.setAttribute("aria-label", "Complete JSON payload")
    const fallback = namedElement("details", "admin-json-fallback", "")
    const summary = namedElement("summary", "", "Edit entire input as JSON")
    fallback.append(summary, whole)
    const submit = namedElement("button", "admin-button admin-button-primary", "Run") as HTMLButtonElement
    submit.type = "submit"
    form.append(fields, fallback, submit)

    const input = () => {
      const source = whole.value.trim()
      if (source) return parseJson(source, "Complete JSON payload must be valid JSON")

      if (noInput) return Effect.succeed(null)

      if (!objectInput) {
        const first = Array.head(controls)
        const emptyInput = Effect.succeed(null)
        return Option.match(first, { onNone: Function.constant(emptyInput), onSome: ({control: control}) => control.value() })
      }

      const selected = Array.filter(controls, selectedEntry)
      const entries = Effect.forEach(selected, entryValue)
      return Effect.map(entries, Record.fromEntries)
    }

    return { form, submit, input }
  }

  const showResult = (value: unknown) => {
    const result = namedElement("pre", "admin-result", "")
    const resultValue = pipe(Option.fromUndefinedOr(value), Option.getOrElse(Function.constant(null)))
    result.textContent = textFor(resultValue)
    return result
  }

  const showErrorAt = (target: HTMLElement) =>
    (error: ApplicationUiInputError | ApplicationUiRequestError) => Effect.sync(() => {
      const failure = notice("error", error.message)
      target.replaceChildren(failure)
    })

  const run = (
    effect: Effect.Effect<void, ApplicationUiInputError | ApplicationUiRequestError, HttpClient.HttpClient>,
    errorTarget: HTMLElement = content,
  ) => pipe(effect, Effect.catch(showErrorAt(errorTarget)), Effect.provide(FetchHttpClient.layer), Effect.runPromise)

  const renderList = Effect.fn("ApplicationUi.renderList")(function* (resource: Resource) {
    const entry = yield* lookupOperation(`${resource.name}.list`)
    if (Option.isNone(entry)) return
    clear(content)
    const heading = yield* resourceLabel(resource)
    const titleElement = namedElement("h2", "", heading)
    content.append(titleElement)
    const inputSchema = pipe(Option.fromUndefinedOr(entry.value.input.schema), Option.getOrElse(Record.empty<string, unknown>))
    const input = resolveSchema(inputSchema, entry.value.input)
    const inputProperties = pipe(Option.fromNullishOr(input.properties), Option.filter(isRecords), Option.getOrElse(Record.empty<string, unknown>))
    const filterSchema = pipe(fieldValue(inputProperties, "filter"), Option.filter(isJsonSchema))
    const rawFilter = pipe(filterSchema, Option.map((value) => resolveSchema(value, entry.value.input)))
    const filterProperties = pipe(rawFilter, Option.flatMap(flow(Struct.get("properties"), Option.fromNullishOr, Option.filter(isRecords))))
    const filterForm = namedElement("form", "admin-filter-form", "")
    const fields = namedElement("div", "admin-fields", "")
    const properties = pipe(filterProperties, Option.getOrElse(Record.empty<string, unknown>))
    const filterEntries = Record.toEntries(properties)

    const equalityControl = ([name, value]: readonly [string, unknown]) => {
      const schema = pipe(Option.some(value), Option.filter(isJsonSchema))
      const control = pipe(schema, Option.flatMap((property) => formControl(name, property, entry.value.input, false, absentValue, noAncestors)))
      const named = (control: FormControl) => FormEntry.make({ name, control })
      return pipe(control, Option.map(named))
    }

    const filters = pipe(filterEntries, Array.map(equalityControl), Array.getSomes)

    const appendFilter = ({ control: control }: FormEntry) => {
      fields.append(control.node)
      return control
    }

    Array.forEach(filters, appendFilter)
    const hasLimit = Record.has(inputProperties, "limit")
    const hasCursor = Record.has(inputProperties, "cursor")
    const limit = namedElement("input", "admin-input admin-limit", "") as HTMLInputElement
    limit.type = "number"
    limit.min = "1"
    limit.step = "1"
    limit.placeholder = "Limit"
    limit.setAttribute("aria-label", "List limit")
    const apply = namedElement("button", "admin-button admin-button-secondary", "Apply") as HTMLButtonElement
    apply.type = "submit"
    filterForm.append(fields)
    if (hasLimit) filterForm.append(limit)
    filterForm.append(apply)
    const result = namedElement("div", "admin-list-result", "")
    content.append(filterForm, result)

    const loadPage = Effect.fn("ApplicationUi.loadPage")(function* (cursor: Option.Option<string>, history: ReadonlyArray<Option.Option<string>>) {
      apply.disabled = true
      const loading = notice("loading", "Loading rows…")
      result.replaceChildren(loading)
      const selected = Array.filter(filters, selectedEntry)
      const entries = yield* Effect.forEach(selected, entryValue)
      const filter = Record.fromEntries(entries)
      const filterEntry = Record.isEmptyRecord(filter) ? [] : [["filter", filter] as const]
      const hasValue = Boolean(limit.value)
      const includeLimit = hasLimit && hasValue
      const limitEntry = includeLimit ? [["limit", Number(limit.value)] as const] : []
      const cursorEntry = Option.match(cursor, { onNone: Function.constant([]), onSome: (value) => hasCursor ? [["cursor", value] as const] : [] })
      const payload = Record.fromEntries([...filterEntry, ...limitEntry, ...cursorEntry])
      const value = yield* call(entry.value.name, payload)

      const page = pipe(Match.value(value),
        Match.when(isRecords, (record) => {
          const items = pipe(fieldValue(record, "items"), Option.filter(isJsonArray), Option.getOrElse(emptyUnknownArray))
          const nextCursor = pipe(fieldValue(record, "nextCursor"), Option.filter(isString))
          return PageSchema.make({ items, nextCursor })
        }),
        Match.orElse(noPage),
      )

      const configured = yield* resourcePresentation(resource)
      const configuredColumns = pipe(configured, Option.flatMap(flow(Struct.get("columns"), Option.fromUndefinedOr)))
      const stored = pipe(Option.fromUndefinedOr(resource.storage), Option.flatMap(flow(Struct.get("physical"), Option.fromUndefinedOr)))
      const physicalFields = pipe(stored, Option.flatMap(flow(Struct.get("fields"), Option.fromUndefinedOr)))
      const storageColumns = pipe(physicalFields, Option.map(Array.map(Struct.get("name"))))
      const inferredColumns = pipe(page.items, Array.filter(isRecords), Array.flatMap(Record.keys), Array.dedupe)
      const columns = pipe(configuredColumns, Option.orElse(Function.constant(storageColumns)), Option.getOrElse(Function.constant(inferredColumns)))
      const table = namedElement("table", "admin-table", "")
      const tableHead = emptyElement("thead")
      const headerRow = emptyElement("tr")

      const appendHeading = (column: string) => {
        const heading = namedElement("th", "", column)
        headerRow.append(heading)
        return heading
      }

      Array.forEach(columns, appendHeading)
      tableHead.append(headerRow)
      table.append(tableHead)
      const body = emptyElement("tbody")

      const appendRow = (row: unknown) => {
        const tableRow = emptyElement("tr")

        const appendValue = (column: string) => {
          const value = isRecords(row) ? pipe(fieldValue(row, column), Option.getOrElse(Function.constant(null))) : row
          const text = textFor(value)
          const cell = namedElement("td", "", text)
          tableRow.append(cell)
          return cell
        }

        Array.forEach(columns, appendValue)
        body.append(tableRow)
        return tableRow
      }

      Array.forEach(page.items, appendRow)
      table.append(body)

      if (hasCursor) {
        const paging = namedElement("div", "admin-paging", "")
        const back = namedElement("button", "admin-button admin-button-secondary", "Back") as HTMLButtonElement
        back.type = "button"
        back.disabled = Array.isReadonlyArrayEmpty(history)

        const onBack: EventListener = () => {
          const previous = Array.last(history)
          const before = Array.dropRight(history, 1)
          const program = Option.match(previous, { onNone: Function.constant(Effect.void), onSome: (value) => loadPage(value, before) })
          run(program)
        }

        back.addEventListener("click", onBack)
        const next = namedElement("button", "admin-button admin-button-secondary", "Next") as HTMLButtonElement
        next.type = "button"
        next.disabled = Option.isNone(page.nextCursor)

        const onNext: EventListener = () => {
          const nextHistory = Array.append(history, cursor)

          const program = Option.match(page.nextCursor, { onNone: Function.constant(Effect.void), onSome: (value) => {
            const cursor = Option.some(value)
            return loadPage(cursor, nextHistory)
          } })

          run(program)
        }

        next.addEventListener("click", onNext)
        paging.append(back, next)
        result.replaceChildren(table, paging)
      } else result.replaceChildren(table)

      apply.disabled = false
    })

    const onSubmit: EventListener = (event) => {
      event.preventDefault()
      const program = loadPage(noCursor, [])
      run(program)
    }

    filterForm.addEventListener("submit", onSubmit)
    yield* loadPage(noCursor, [])
  })

  const renderOperation = Effect.fn("ApplicationUi.renderOperation")(function* (entry: Operation, resource: Option.Option<Resource>) {
    clear(content)
    const label = yield* operationLabel(entry)
    const heading = namedElement("h2", "", label)
    content.append(heading)
    const presentation = yield* operationPresentation(entry)
    const description = pipe(presentation, Option.flatMap(flow(Struct.get("description"), Option.fromUndefinedOr)))

    const appendDescription = (text: string) => {
      const paragraph = namedElement("p", "admin-description", text)
      content.append(paragraph)
      return paragraph
    }

    Option.match(description, { onNone: Function.constant(content), onSome: appendDescription })
    const generated = generatedForm(entry, absentValue)
    const result = namedElement("div", "admin-operation-result", "")

    const onSubmit: EventListener = (event) => {
      event.preventDefault()

      const workflow = Effect.gen(function* () {
        const input = yield* generated.input()
        generated.submit.disabled = true
        const loading = notice("loading", "Calling operation…")
        result.replaceChildren(loading)
        const value = yield* call(entry.name, input)
        const loginResult = equals(entry.name, "identity.login")
        const resultRecord = pipe(Option.some(value), Option.filter(isRecords))
        const issuedToken = loginResult ? pipe(resultRecord, Option.flatMap((record) => fieldValue(record, "token")), Option.filter(isString)) : Option.none<string>()
        if (Option.isSome(issuedToken)) token.value = issuedToken.value
        if (equals(entry.name, "identity.logout")) token.value = ""
        const completed = notice("success", "Operation completed.")
        const display = showResult(value)
        result.replaceChildren(completed, display)
        const action = pipe(entry.name.split("."), Array.last)
        const refreshable = pipe(resource, Option.filter(flow(Struct.get("operations"), Array.contains("list"))))
        const mutation = pipe(action, Option.filter((value) => Array.contains(["create", "update", "patch", "remove"], value)))
        const refresh = pipe(mutation, Option.flatMap(Function.constant(refreshable)))
        yield* Option.match(refresh, { onNone: Function.constant(Effect.void), onSome: renderList })
      })

      const restoreSubmit = Effect.sync(() => {
        generated.submit.disabled = false
      })

      const guarded = Effect.ensuring(workflow, restoreSubmit)
      run(guarded, result)
    }

    generated.form.addEventListener("submit", onSubmit)
    content.append(generated.form, result)
  })

  const renderNavigation = Effect.fn("ApplicationUi.renderNavigation")(function* () {
    clear(navigation)
    const current = yield* Ref.get(state)
    if (Option.isNone(current.inspection)) return
    const resources = namedElement("div", "admin-nav-group", "")
    const resourceHeading = namedElement("h2", "admin-nav-title", "Resources")
    resources.append(resourceHeading)

    const appendResource = Effect.fn("ApplicationUi.appendResource")(function* (resource: Resource) {
        const selectedResource = Option.some(resource)
        const label = yield* resourceLabel(resource)
        const resourceButton = namedElement("button", "admin-nav-resource", label) as HTMLButtonElement
        resourceButton.type = "button"

        const onResourceClick: EventListener = () => {
          const list = Array.contains(resource.operations, "list")
          const fallback = Array.head(resource.operations)
          const operation = pipe(fallback, Option.map((name) => `${resource.name}.${name}`))

          const program = list
            ? renderList(resource)
            : Effect.gen(function* () {
              const candidate = yield* Option.match(operation, { onNone: noOperation, onSome: lookupOperation })
              yield* Option.match(candidate, { onNone: Function.constant(Effect.void), onSome: (entry) => renderOperation(entry, selectedResource) })
            })

          run(program)
        }

        resourceButton.addEventListener("click", onResourceClick)
        resources.append(resourceButton)
        const operations = namedElement("div", "admin-nav-operations", "")

        const appendOperation = Effect.fn("ApplicationUi.appendOperation")(function* (name: string) {
            const entry = yield* lookupOperation(`${resource.name}.${name}`)
            const noEntry = Effect.succeed(name)
            const buttonLabel = yield* Option.match(entry, { onNone: Function.constant(noEntry), onSome: operationLabel })
            const button = namedElement("button", "admin-nav-operation", buttonLabel) as HTMLButtonElement
            button.type = "button"

            const onOperationClick: EventListener = () => {
              const list = equals(name, "list")

              const program = list
                ? renderList(resource)
                : Effect.gen(function* () {
                  const selected = yield* lookupOperation(`${resource.name}.${name}`)
                  yield* Option.match(selected, { onNone: Function.constant(Effect.void), onSome: (value) => renderOperation(value, selectedResource) })
                })

              run(program)
            }

            button.addEventListener("click", onOperationClick)
            operations.append(button)
        })

        yield* Effect.forEach(resource.operations, appendOperation, { discard: true })
        resources.append(operations)
    })

    yield* Effect.forEach(current.inspection.value.resources, appendResource, { discard: true })
    navigation.append(resources)
    const operationNames = (resource: Resource) => Array.map(resource.operations, (name) => `${resource.name}.${name}`)
    const names = pipe(current.inspection.value.resources, Array.flatMap(operationNames), HashSet.fromIterable)
    const isCommand = (entry: Operation) => !HashSet.has(names, entry.name)
    const commands = Array.filter(current.inspection.value.operations, isCommand)
    const commandsExist = !Array.isReadonlyArrayEmpty(commands)

    if (commandsExist) {
      const group = namedElement("div", "admin-nav-group", "")
      const commandHeading = namedElement("h2", "admin-nav-title", "Commands")
      group.append(commandHeading)

      const appendCommand = (entry: Operation) => {
        const program = Effect.gen(function* () {
          const label = yield* operationLabel(entry)
          const button = namedElement("button", "admin-nav-resource", label) as HTMLButtonElement
          button.type = "button"
          const onCommandClick: EventListener = () => pipe(renderOperation(entry, noResource), run)
          button.addEventListener("click", onCommandClick)
          group.append(button)
        })

        run(program)
        return entry
      }

      Array.forEach(commands, appendCommand)
      navigation.append(group)
    }
  })

  const load = Effect.fn("ApplicationUi.load")(function* () {
    const loading = notice("loading", "Loading application metadata…")
    content.replaceChildren(loading)
    const body = yield* getJson("/api")
    const decoder = Schema.decodeUnknownEffect(MetadataSchema)
    const decoded = decoder(body)
    const invalidMetadata = pipe(ApplicationUiRequestError.make({ message: "Application UI metadata was invalid." }), Function.constant)
    const metadata = yield* Effect.mapError(decoded, invalidMetadata)
    const presentation: Option.Option<ApplicationUiPresentation> = Option.fromUndefinedOr(metadata.presentation)
    const next = ClientStateSchema.make({ inspection: Option.some(metadata), presentation })
    yield* Ref.set(state, next)
    applicationTitle.textContent = pipe(presentation, Option.flatMap(flow(Struct.get("title"), Option.fromUndefinedOr)), Option.getOrElse(Function.constant(metadata.application)))
    subtitle.textContent = pipe(presentation, Option.flatMap(flow(Struct.get("description"), Option.fromUndefinedOr)), Option.getOrElse(Function.constant("Generated application")))
    yield* renderNavigation()
    const first = Array.findFirst(metadata.resources, flow(Struct.get("operations"), Array.contains("list")))
    const firstOperation = Array.head(metadata.operations)

    yield* Option.match(first, {
      onSome: renderList,
      onNone: () => Option.match(firstOperation, { onSome: (entry) => renderOperation(entry, noResource), onNone: () => Effect.sync(() => {
        const unavailable = notice("error", "The application has no published operations.")
        content.replaceChildren(unavailable)
      }) }),
    })
  })

  const onReload: EventListener = () => pipe(load(), run)
  reload.addEventListener("click", onReload)
  yield* pipe(load(), Effect.catch(showErrorAt(content)))
})

const program = pipe(Option.fromNullishOr(root), Option.match({ onNone: noEffect, onSome: mount }))
const provided = Effect.provide(program, FetchHttpClient.layer)

await Effect.runPromise(provided)
