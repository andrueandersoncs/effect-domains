import { Array, Effect, Equivalence, Option, Predicate, Record, Schema, Struct, pipe } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Authorization } from "./authorization.ts"
import { BrowserModel } from "./browser-model.ts"
import { Requests, RequestStateSchema, RequestTokenSchema } from "./requests.ts"
import { RpcBrowser } from "./rpc-browser.ts"
import { RpcService, type Type } from "./rpc-service.ts"
import { Page, type Page as PageValue } from "./page.ts"
import { ResourcePager } from "./resource-pager.ts"

const EditorCapabilitiesSchema = Schema.Struct({
  list: Schema.Literal(true),
  create: Schema.Literal(true),
  update: Schema.Literal(true),
  remove: Schema.Literal(true),
})

class RpcClientDefinitionError extends Schema.TaggedError<RpcClientDefinitionError>()("RpcClientDefinitionError", {
  method: Schema.String,
  reason: Schema.String,
}) {}

interface RpcMethod<Output> {
  (input: unknown): Effect.Effect<Output, unknown>
}

const isRpcMethod = <Output>(value: unknown): value is RpcMethod<Output> => {
  const callable = Predicate.isFunction(value)
  return callable
}

const make = <
  const Name extends string,
  const ResourceName extends string,
  const IdentifierKey extends string,
  Identifier,
  Draft extends Readonly<Record<string, unknown>>,
  Row extends Draft & Readonly<Record<IdentifierKey, Identifier>>,
  FormValue extends Readonly<Record<string, unknown>>,
  Rpcs extends Rpc.Any,
  Query extends Readonly<Record<string, unknown>>,
  QueryForm extends Readonly<Record<string, unknown>>,
>(options: Readonly<{
  name: Name
  resource: Readonly<{
    name: ResourceName
    authorization: typeof Authorization.public
    published: Readonly<{
      list: true
      create: true
      update: true
      remove: true
    }>
    createInputSchema: Schema.Codec<Draft, unknown, unknown, unknown>
    table: Readonly<{
      identifier: IdentifierKey
      identifierSchema: Schema.Codec<Identifier, unknown, never, never>
      rowSchema: Schema.Codec<Row, unknown, never, never>
    }>
    contracts: Readonly<{
      list: Readonly<{ successSchema: Schema.Codec<PageValue<Row>, unknown, never, never> }>
    }>
    group: RpcGroup.RpcGroup<Rpcs>
  }>
  form: Schema.Codec<Draft, FormValue, never, never>
  empty: FormValue
  query: Readonly<{
    form: Schema.Codec<Query, QueryForm, never, never>
    empty: QueryForm
  }>
  notices: Readonly<{ created: string; updated: string; removed: string }>
  formatError: (error: unknown) => string
}>) => {
  const capabilities = pipe(
    options.resource.published,
    Option.liftPredicate(Schema.is(EditorCapabilitiesSchema)),
    Option.getOrThrow,
  )

  const listKey = `${options.resource.name}.list`
  const saveKey = `${options.resource.name}.save`
  const removeKey = `${options.resource.name}.remove`
  const pager = ResourcePager.make(listKey)
  const listMethod = `${options.resource.name}.${capabilities.list ? "list" : ""}`
  const createMethod = `${options.resource.name}.${capabilities.create ? "create" : ""}`
  const updateMethod = `${options.resource.name}.${capabilities.update ? "update" : ""}`
  const removeMethod = `${options.resource.name}.${capabilities.remove ? "remove" : ""}`
  const FormValueSchema = Schema.toEncoded(options.form)
  const QueryFormSchema = Schema.toEncoded(options.query.form)
  const OptionalIdentifierSchema = Schema.NullOr(options.resource.table.identifierSchema)
  const CursorSchema = Schema.NullOr(Schema.String)

  const SavingSchema = Schema.NullOr(Schema.Struct({
    form: FormValueSchema,
    selectedId: OptionalIdentifierSchema,
  }))

  const isFormValue = Schema.is(FormValueSchema)
  const isQueryForm = Schema.is(QueryFormSchema)
  const sameIdentifier = Equivalence.strictEqual<Identifier>()
  const sameKey = Equivalence.strictEqual<string>()
  const sameForm = Schema.toEquivalence(FormValueSchema)
  const sameOptionalIdentifier = Schema.toEquivalence(OptionalIdentifierSchema)
  const Client = RpcService.make({ name: `${options.name}/Client`, group: options.resource.group })
  type Client = Type<typeof Client>
  type ClientValue = Effect.Success<typeof Client>

  const invoke = <Output>(client: ClientValue, name: string, input: unknown) => {
    const method = Reflect.get(client, name)

    if (!isRpcMethod<Output>(method)) {
      const error = RpcClientDefinitionError.make({ method: name, reason: "missing generated method" })
      return Effect.die(error)
    }

    return method(input)
  }

  const ModelSchema = Schema.Struct({
    items: Schema.Array(options.resource.table.rowSchema),
    nextCursor: CursorSchema,
    refresh: Schema.Int,
    query: QueryFormSchema,
    form: FormValueSchema,
    selectedId: OptionalIdentifierSchema,
    saving: SavingSchema,
    requests: RequestStateSchema,
    fieldErrors: BrowserModel.FieldErrorsSchema,
    notice: BrowserModel.NoticeSchema,
  })

  interface Model extends Schema.Schema.Type<typeof ModelSchema> {}

  const UpdateResultSchema = Schema.Struct({
    model: ModelSchema,
    commands: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  })

  const MessageSchema = defineMessageUnion({
    ChangedField: { key: Schema.String, value: Schema.Unknown },
    ChangedQueryField: { key: Schema.String, value: Schema.Unknown },
    ClickedReload: {},
    ClickedNext: {},
    ClickedSave: {},
    ClickedNew: {},
    ClickedSelect: { id: options.resource.table.identifierSchema },
    ClickedRemove: { id: options.resource.table.identifierSchema },
    SucceededList: { page: options.resource.contracts.list.successSchema, append: Schema.Boolean, request: RequestTokenSchema },
    SynchronizedList: { page: options.resource.contracts.list.successSchema },
    FailedList: { error: Schema.String },
    SucceededSave: { row: options.resource.table.rowSchema, created: Schema.Boolean, request: RequestTokenSchema },
    SucceededRemove: { id: options.resource.table.identifierSchema, request: RequestTokenSchema },
    Failed: { request: RequestTokenSchema, error: Schema.String, fieldErrors: BrowserModel.FieldErrorsSchema },
  })

  type Message = typeof MessageSchema.Type
  type UpdateReturn = Update.Return<Model, Message, Client | Reactivity.Reactivity>

  const result = (model: Model) =>
    UpdateResultSchema.make({ model }) as UpdateReturn

  const commanded = (
    model: Model,
    commands: NonNullable<UpdateReturn["commands"]>,
  ) => UpdateResultSchema.make({ model, commands }) as UpdateReturn

  const rowIdentifier = (row: Row) => row[options.resource.table.identifier]
  const decodeQuery = Schema.decodeUnknownEffect(options.query.form)

  const listInput = (query: Query, cursor: string | null) => {
    const page = Page.input(cursor)
    return Struct.assign(query, page)
  }

  const rowToForm = Schema.encodeUnknownSync(options.form)

  const savingIsCurrent = (model: Model) => pipe(
    Option.fromNullishOr(model.saving),
    Option.exists(({ form, selectedId }) =>
      sameForm(model.form, form) && sameOptionalIdentifier(model.selectedId, selectedId)),
  )

  const failurePayload = (error: unknown) =>
    BrowserModel.failure(error, options.formatError)

  class ListArgs extends Schema.Class<ListArgs>(`${options.name}/ListArgs`)({
    query: QueryFormSchema,
    cursor: CursorSchema,
    append: Schema.Boolean,
  }) {}

  const loadPage = Effect.fn("ResourceEditor.loadPage")(function* ({ query, cursor, append }: ListArgs) {
    const client = yield* Client
    const decoded = yield* decodeQuery(query)
    const input = listInput(decoded, cursor)
    const page = yield* invoke<PageValue<Row>>(client, listMethod, input)

    return { page, append }
  })

  const List = RpcBrowser.command(`${options.name}.List`, {
    request: listKey,
    args: ListArgs.fields,
    success: MessageSchema.SucceededList,
    failure: MessageSchema.Failed,
    execute: loadPage,
    failurePayload,
  })

  class SyncDependencies extends Schema.Class<SyncDependencies>(`${options.name}/SyncDependencies`)({
    query: QueryFormSchema,
    refresh: Schema.Int,
  }) {}

  const selectSyncDependencies = (model: Model) =>
    SyncDependencies.make({ query: model.query, refresh: model.refresh })

  const selectSynchronizedPage = Effect.fn("ResourceEditor.selectSynchronizedPage")(
    function* ({ query }: SyncDependencies) {
      const client = yield* Client
      const decoded = yield* decodeQuery(query)
      const input = listInput(decoded, null)
      const page = yield* invoke<PageValue<Row>>(client, listMethod, input)

      return { page }
    },
  )

  const subscriptions = RpcBrowser.query<Model, Message>()(`${options.name}.Sync`, {
    dependencies: SyncDependencies.fields,
    modelToDependencies: selectSyncDependencies,
    reactivityKeys: [options.resource],
    execute: selectSynchronizedPage,
    success: MessageSchema.SynchronizedList,
    failure: MessageSchema.FailedList,
    formatError: options.formatError,
  })

  class SaveArgs extends Schema.Class<SaveArgs>(`${options.name}/SaveArgs`)({
    selectedId: OptionalIdentifierSchema,
    form: FormValueSchema,
  }) {}

  const executeSave = Effect.fn("ResourceEditor.executeSave")(function* ({ selectedId, form }: SaveArgs) {
    const draft = yield* pipe(
      Schema.decodeUnknownEffect(options.form)(form),
      Effect.mapError(BrowserModel.formFailure),
    )

    const client = yield* Client
    const created = Predicate.isNull(selectedId)

    const row = yield* created
      ? invoke<Row>(client, createMethod, draft)
      : Effect.gen(function* () {
        const candidate = Record.set(draft, options.resource.table.identifier, selectedId)
        const input = yield* Schema.decodeUnknownEffect(options.resource.table.rowSchema)(candidate)
        return yield* invoke<Row>(client, updateMethod, input)
      })

    return { row, created }
  })

  const Save = RpcBrowser.mutation(`${options.name}.Save`, {
    request: { key: saveKey, concurrency: "exhaust" },
    args: SaveArgs.fields,
    success: MessageSchema.SucceededSave,
    failure: MessageSchema.Failed,
    execute: executeSave,
    failurePayload,
    invalidates: [options.resource],
  })

  class RemoveArgs extends Schema.Class<RemoveArgs>(`${options.name}/RemoveArgs`)({
    id: options.resource.table.identifierSchema,
  }) {}

  const RemoveInputSchema = Schema.Record(Schema.String, options.resource.table.identifierSchema)

  const makeRemove = Effect.fn("ResourceEditor.makeRemove")(function* ({ id }: RemoveArgs) {
    const client = yield* Client
    const input = RemoveInputSchema.make({ [options.resource.table.identifier]: id })
    yield* invoke<void>(client, removeMethod, input)

    return { id }
  })

  const Remove = RpcBrowser.mutation(`${options.name}.Remove`, {
    request: { key: removeKey, concurrency: "exhaust" },
    args: RemoveArgs.fields,
    success: MessageSchema.SucceededRemove,
    failure: MessageSchema.Failed,
    execute: makeRemove,
    failurePayload,
    invalidates: [options.resource],
  })

  const beginList = (model: Model, append: boolean): UpdateReturn => {
    const page = options.resource.contracts.list.successSchema.make({
      items: model.items,
      nextCursor: model.nextCursor,
    })

    const started = pipe(
      pager.begin(model.requests, page, append),
      Option.getOrThrow,
    )

    const next = ModelSchema.make({
      ...model,
      items: started.page.items,
      nextCursor: started.page.nextCursor,
      requests: started.requests,
    })

    const command = List.command({
      query: model.query,
      request: started.request,
      cursor: started.cursor,
      append: started.append,
    })

    return commanded(next, [command])
  }

  const reload = (model: Model) => {
    const invalidated = pager.invalidate({
      page: { items: model.items, nextCursor: model.nextCursor },
      requests: model.requests,
    })

    const next = ModelSchema.make({
      ...model,
      items: invalidated.page.items,
      nextCursor: invalidated.page.nextCursor,
      requests: invalidated.requests,
      refresh: model.refresh + 1,
      notice: null,
    })

    return result(next)
  }

  const update = (model: Model, message: Message) => MessageSchema.match<UpdateReturn>(message, {
    ChangedField: ({ key, value }) => {
      if (!Record.has(model.form, key)) return result(model)

      const candidate = Record.set(model.form, key, value)

      if (!isFormValue(candidate)) return result(model)

      const next = ModelSchema.make({ ...model, form: candidate })

      return result(next)
    },
    ChangedQueryField: ({ key, value }) => {
      if (!Record.has(model.query, key)) return result(model)

      const candidate = Record.set(model.query, key, value)
      if (!isQueryForm(candidate)) return result(model)

      const invalidated = pager.invalidate({
        page: { items: model.items, nextCursor: model.nextCursor },
        requests: model.requests,
      })

      const next = ModelSchema.make({
        ...model,
        query: candidate,
        items: invalidated.page.items,
        nextCursor: invalidated.page.nextCursor,
        requests: invalidated.requests,
        notice: null,
      })

      return result(next)
    },
    ClickedReload: () => reload(model),
    ClickedNext: () => {
      const endReached = Predicate.isNull(model.nextCursor)
      const unavailable = endReached || List.pending(model)

      return unavailable ? result(model) : beginList(model, true)
    },
    ClickedSave: () => {
      const fieldErrors = BrowserModel.emptyFieldErrors()
      const saving = SavingSchema.make({ form: model.form, selectedId: model.selectedId })
      const patch = Object.freeze({ fieldErrors, notice: null, saving })

      const started = Save.start(model, {
        selectedId: model.selectedId,
        form: model.form,
      }, patch)

      const next = ModelSchema.make(started.model)

      return commanded(next, started.commands)
    },
    ClickedNew: () => pipe(
      ModelSchema.make({
        ...model,
        form: options.empty,
        selectedId: null,
        fieldErrors: BrowserModel.emptyFieldErrors(),
        notice: null,
      }),
      result,
    ),
    ClickedSelect: ({ id }) => {
      const matchesIdentifier = (row: Row) => {
        const rowId = rowIdentifier(row)
        return sameIdentifier(rowId, id)
      }

      const selected = Array.findFirst(model.items, matchesIdentifier)

      return Option.match(selected, {
        onNone: () => result(model),
        onSome: (row) => pipe(
          ModelSchema.make({
            ...model,
            form: rowToForm(row),
            selectedId: id,
            fieldErrors: BrowserModel.emptyFieldErrors(),
            notice: null,
          }),
          result,
        ),
      })
    },
    ClickedRemove: ({ id }) => {
      const started = Remove.start(model, { id }, { notice: null })
      const next = ModelSchema.make(started.model)
      return commanded(next, started.commands)
    },
    SynchronizedList: ({ page }) => {

      const invalidated = RpcBrowser.invalidate(model, listKey, {
        items: page.items,
        nextCursor: page.nextCursor,
      })

      const next = ModelSchema.make(invalidated.model)
      return result(next)
    },
    FailedList: ({ error }) => {
      const notice = BrowserModel.NoticeSchema.make({ kind: "error", text: error })
      const invalidated = RpcBrowser.invalidate(model, listKey, { notice })
      const next = ModelSchema.make(invalidated.model)

      return result(next)
    },
    SucceededList: ({ page, append, request }) => pipe(
      pager.receive(
        { page: { items: model.items, nextCursor: model.nextCursor }, requests: model.requests },
        request,
        page,
        append,
      ),
      Option.match({
        onNone: () => result(model),
        onSome: (received) => pipe(
          ModelSchema.make({
            ...model,
            items: received.page.items,
            nextCursor: received.page.nextCursor,
            requests: received.requests,
          }),
          result,
        ),
      }),
    ),
    SucceededSave: ({ row, created, request }) => {
      const current = savingIsCurrent(model)
      const form = current ? rowToForm(row) : model.form
      const selectedId = current ? rowIdentifier(row) : model.selectedId
      const text = created ? options.notices.created : options.notices.updated
      const notice = BrowserModel.NoticeSchema.make({ kind: "success", text })
      const settled = RpcBrowser.succeed(model, request, { form, selectedId, saving: null, notice })
      const next = ModelSchema.make(settled.model)

      return result(next)
    },
    SucceededRemove: ({ id, request }) => {
      const matchesIdentifier = (selectedId: Identifier) => sameIdentifier(selectedId, id)
      const selected = pipe(Option.fromNullishOr(model.selectedId), Option.exists(matchesIdentifier))
      const form = selected ? options.empty : model.form
      const selectedId = selected ? null : model.selectedId
      const notice = BrowserModel.NoticeSchema.make({ kind: "success", text: options.notices.removed })
      const settled = RpcBrowser.succeed(model, request, { form, selectedId, notice })
      const next = ModelSchema.make(settled.model)

      return result(next)
    },
    Failed: ({ request, error, fieldErrors }) => {
      const saveRequest = sameKey(request.key, Save.requestKey)
      const savingChanged = !savingIsCurrent(model)
      const changedSinceSave = saveRequest && savingChanged
      const saving = saveRequest ? null : model.saving

      if (changedSinceSave) {
        const settled = RpcBrowser.succeed(model, request, { saving })
        const next = ModelSchema.make(settled.model)
        return result(next)
      }

      const mergedErrors = Record.isEmptyRecord(fieldErrors)
        ? model.fieldErrors
        : Record.union(model.fieldErrors, fieldErrors, (_, incoming) => incoming)

      const notice = BrowserModel.NoticeSchema.make({ kind: "error", text: error })

      const settled = RpcBrowser.fail(model, request, error, {
        saving,
        fieldErrors: mergedErrors,
        notice,
      })

      const next = ModelSchema.make(settled.model)

      return result(next)
    },
  })

  const init = () => pipe(
    ModelSchema.make({
      items: [],
      nextCursor: null,
      refresh: 0,
      query: options.query.empty,
      form: options.empty,
      selectedId: null,
      saving: null,
      requests: Requests.empty(),
      fieldErrors: BrowserModel.emptyFieldErrors(),
      notice: null,
    }),
    result,
  )

  const operations = Object.freeze({ list: List, save: Save, remove: Remove })

  const pending = (model: Model, operation: keyof typeof operations) =>
    operations[operation].pending(model)

  return Object.freeze({ Client, Model: ModelSchema, Message: MessageSchema, subscriptions, init, update, pending })
}

export const ResourceEditor = { make }
