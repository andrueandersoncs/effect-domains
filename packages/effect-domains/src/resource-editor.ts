import { Array, Effect, Equivalence, Function, Match, Option, Predicate, Record, Schema, flow, pipe } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Authorization } from "./authorization.ts"
import { Form } from "./form.ts"
import { Requests, RequestStateSchema, RequestTokenSchema, type RequestToken } from "./requests.ts"
import { RpcService, type Type } from "./rpc-service.ts"
import { Page, type Page as PageValue } from "./page.ts"
import { ResourcePager } from "./resource-pager.ts"

const NoticeSchema = Schema.NullOr(Schema.Struct({
  kind: Schema.Literals(["info", "error", "success"]),
  text: Schema.String,
}))

const FieldErrorsSchema = Schema.Record(Schema.String, Schema.String)

const EditorCapabilitiesSchema = Schema.Struct({
  list: Schema.Literal(true),
  create: Schema.Literal(true),
  update: Schema.Literal(true),
  remove: Schema.Literal(true),
})

const FormFailureSchema = Schema.TaggedStruct("FormFailure", {
  errors: FieldErrorsSchema,
  message: Schema.String,
})

const isFormFailure = Schema.is(FormFailureSchema)

const firstError = (errors: Readonly<Record<string, string>>, fallback: string) => pipe(
  Record.values(errors),
  Array.head,
  Option.getOrElse(Function.constant(fallback)),
)

const formFailure = (error: Schema.SchemaError) => {
  const errors = Form.errors(error)
  const message = firstError(errors, error.message)

  return FormFailureSchema.make({ errors, message })
}

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
  const OptionalIdentifierSchema = Schema.NullOr(options.resource.table.identifierSchema)

  const SavingSchema = Schema.NullOr(Schema.Struct({
    form: FormValueSchema,
    selectedId: OptionalIdentifierSchema,
  }))

  const isFormValue = Schema.is(FormValueSchema)
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
    nextCursor: Schema.NullOr(Schema.String),
    form: FormValueSchema,
    selectedId: OptionalIdentifierSchema,
    saving: SavingSchema,
    requests: RequestStateSchema,
    fieldErrors: FieldErrorsSchema,
    notice: NoticeSchema,
  })

  interface Model extends Schema.Schema.Type<typeof ModelSchema> {}

  const MessageSchema = defineMessageUnion({
    ChangedField: { key: Schema.String, value: Schema.Unknown },
    ClickedReload: {},
    ClickedNext: {},
    ClickedSave: {},
    ClickedNew: {},
    ClickedSelect: { id: options.resource.table.identifierSchema },
    ClickedRemove: { id: options.resource.table.identifierSchema },
    SucceededList: { page: options.resource.contracts.list.successSchema, append: Schema.Boolean, request: RequestTokenSchema },
    SucceededSave: { row: options.resource.table.rowSchema, created: Schema.Boolean, request: RequestTokenSchema },
    SucceededRemove: { id: options.resource.table.identifierSchema, request: RequestTokenSchema },
    Failed: { request: RequestTokenSchema, error: Schema.String, fieldErrors: FieldErrorsSchema },
  })

  type Message = typeof MessageSchema.Type
  type UpdateReturn = Update.Return<Model, Message, Client>
  const rowIdentifier = (row: Row) => row[options.resource.table.identifier]
  const rowToForm = Schema.encodeUnknownSync(options.form)

  const savingIsCurrent = (model: Model) => pipe(
    Option.fromNullishOr(model.saving),
    Option.exists(({ form, selectedId }) =>
      sameForm(model.form, form) && sameOptionalIdentifier(model.selectedId, selectedId)),
  )

  const failure = (request: RequestToken, error: unknown) => {
    if (isFormFailure(error)) {
      return MessageSchema.Failed({ request, error: error.message, fieldErrors: error.errors })
    }

    const message = options.formatError(error)
    const fieldErrors = FieldErrorsSchema.make({})

    return MessageSchema.Failed({ request, error: message, fieldErrors })
  }

  const recover = (request: RequestToken) => {
    const toFailure = (error: unknown) => failure(request, error)
    return Effect.catch(flow(toFailure, Effect.succeed))
  }

  const ListArgsSchema = Schema.Struct({
    cursor: Schema.NullOr(Schema.String),
    append: Schema.Boolean,
    request: RequestTokenSchema,
  })


  const List = Command.define(`${options.name}.List`, {
    args: ListArgsSchema.fields,
    messages: [MessageSchema.SucceededList, MessageSchema.Failed],
    execute: ({ cursor, append, request }) => pipe(
      Effect.gen(function* () {
        const client = yield* Client
        const input = Page.input(cursor)
        const page = yield* invoke<PageValue<Row>>(client, listMethod, input)

        return MessageSchema.SucceededList({ page, append, request })
      }),
      recover(request),
    ),
  })

  const SaveArgsSchema = Schema.Struct({
    selectedId: OptionalIdentifierSchema,
    form: FormValueSchema,
    request: RequestTokenSchema,
  })

  const Save = Command.define(`${options.name}.Save`, {
    args: SaveArgsSchema.fields,
    messages: [MessageSchema.SucceededSave, MessageSchema.Failed],
    execute: ({ selectedId, form, request }) => pipe(
      Effect.gen(function* () {
        const draft = yield* pipe(
          Schema.decodeUnknownEffect(options.form)(form),
          Effect.mapError(formFailure),
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

        return MessageSchema.SucceededSave({ row, created, request })
      }),
      recover(request),
    ),
  })

  const RemoveArgsSchema = Schema.Struct({
    id: options.resource.table.identifierSchema,
    request: RequestTokenSchema,
  })

  const RemoveInputSchema = Schema.Record(Schema.String, options.resource.table.identifierSchema)

  const Remove = Command.define(`${options.name}.Remove`, {
    args: RemoveArgsSchema.fields,
    messages: [MessageSchema.SucceededRemove, MessageSchema.Failed],
    execute: ({ id, request }) => pipe(
      Effect.gen(function* () {
        const client = yield* Client
        const input = RemoveInputSchema.make({ [options.resource.table.identifier]: id })
        yield* invoke<void>(client, removeMethod, input)

        return MessageSchema.SucceededRemove({ id, request })
      }),
      recover(request),
    ),
  })

  const beginList = (
    requests: Model["requests"],
    items: ReadonlyArray<Row>,
    nextCursor: string | null,
    append: boolean,
  ) => {
    const started = pipe(
      pager.begin(requests, { items, nextCursor }, append),
      Option.getOrThrow,
    )

    const command = List({
      request: started.request,
      cursor: started.cursor,
      append: started.append,
    })

    return { ...started, command }
  }

  const reload = (model: Model): UpdateReturn => {
    const started = beginList(
      model.requests,
      model.items,
      model.nextCursor,
      false,
    )

    const next = ModelSchema.make({
      items: started.page.items,
      nextCursor: started.page.nextCursor,
      form: model.form,
      selectedId: model.selectedId,
      saving: model.saving,
      requests: started.requests,
      fieldErrors: model.fieldErrors,
      notice: model.notice,
    })

    return { model: next, commands: [started.command] }
  }

  const update = (model: Model, message: Message) => MessageSchema.match<UpdateReturn>(message, {
    ChangedField: ({ key, value }) => {
      if (!Record.has(model.form, key)) return { model }

      const candidate = Record.set(model.form, key, value)

      if (!isFormValue(candidate)) return { model }

      const next = ModelSchema.make({ ...model, form: candidate })

      return { model: next }
    },
    ClickedReload: () => {
      const reloading = reload(model)
      const next = ModelSchema.make({ ...reloading.model, notice: null })

      return { model: next, commands: reloading.commands }
    },
    ClickedNext: () => {
      const endReached = Predicate.isNull(model.nextCursor)
      const alreadyPending = Requests.pending(model.requests, listKey)
      const unavailable = endReached || alreadyPending

      if (unavailable) return { model }

      const started = beginList(
        model.requests,
        model.items,
        model.nextCursor,
        true,
      )

      const next = ModelSchema.make({ ...model, requests: started.requests })

      return { model: next, commands: [started.command] }
    },
    ClickedSave: () => {
      if (Requests.pending(model.requests, saveKey)) return { model }

      const started = Requests.start(model.requests, saveKey)

      const next = ModelSchema.make({
        ...model,
        requests: started.state,
        fieldErrors: FieldErrorsSchema.make({}),
        notice: null,
        saving: SavingSchema.make({ form: model.form, selectedId: model.selectedId }),
      })

      const command = Save({
        selectedId: model.selectedId,
        form: model.form,
        request: started.request,
      })

      return { model: next, commands: [command] }
    },
    ClickedNew: () => {
      const next = ModelSchema.make({
        ...model,
        form: options.empty,
        selectedId: null,
        fieldErrors: FieldErrorsSchema.make({}),
        notice: null,
      })

      return { model: next }
    },
    ClickedSelect: ({ id }) => {
      const matchesIdentifier = (row: Row) => {
        const rowId = rowIdentifier(row)
        return sameIdentifier(rowId, id)
      }

      const selected = Array.findFirst(model.items, matchesIdentifier)

      return Option.match(selected, {
        onNone: () => ({ model }),
        onSome: (row) => {
          const next = ModelSchema.make({
            ...model,
            form: rowToForm(row),
            selectedId: id,
            fieldErrors: FieldErrorsSchema.make({}),
            notice: null,
          })

          return { model: next }
        },
      })
    },
    ClickedRemove: ({ id }) => {
      if (Requests.pending(model.requests, removeKey)) return { model }

      const started = Requests.start(model.requests, removeKey)
      const next = ModelSchema.make({ ...model, requests: started.state, notice: null })
      const command = Remove({ id, request: started.request })

      return { model: next, commands: [command] }
    },
    SucceededList: ({ page, append, request }) => pipe(
      pager.receive(
        { page: { items: model.items, nextCursor: model.nextCursor }, requests: model.requests },
        request,
        page,
        append,
      ),
      Option.match({
        onNone: () => ({ model }),
        onSome: (received) => ({
          model: ModelSchema.make({
            ...model,
            items: received.page.items,
            nextCursor: received.page.nextCursor,
            requests: received.requests,
          }),
        }),
      }),
    ),
    SucceededSave: ({ row, created, request }) => {
      if (!Requests.accepts(model.requests, request)) return { model }

      const current = savingIsCurrent(model)
      const form = current ? rowToForm(row) : model.form
      const selectedId = current ? rowIdentifier(row) : model.selectedId
      const requests = Requests.succeed(model.requests, request)
      const text = created ? options.notices.created : options.notices.updated
      const notice = NoticeSchema.make({ kind: "success", text })
      const settled = ModelSchema.make({ ...model, form, selectedId, requests, saving: null, notice })

      return reload(settled)
    },
    SucceededRemove: ({ id, request }) => {
      if (!Requests.accepts(model.requests, request)) return { model }

      const matchesIdentifier = (selectedId: Identifier) => sameIdentifier(selectedId, id)
      const selected = pipe(Option.fromNullishOr(model.selectedId), Option.exists(matchesIdentifier))
      const form = selected ? options.empty : model.form
      const selectedId = selected ? null : model.selectedId
      const requests = Requests.succeed(model.requests, request)
      const notice = NoticeSchema.make({ kind: "success", text: options.notices.removed })
      const settled = ModelSchema.make({ ...model, form, selectedId, requests, notice })

      return reload(settled)
    },
    Failed: ({ request, error, fieldErrors }) => {
      if (!Requests.accepts(model.requests, request)) return { model }

      const saveRequest = sameKey(request.key, saveKey)
      const savingChanged = !savingIsCurrent(model)
      const changedSinceSave = saveRequest && savingChanged
      const saving = saveRequest ? null : model.saving

      if (changedSinceSave) {
        const requests = Requests.succeed(model.requests, request)
        const next = ModelSchema.make({ ...model, requests, saving })
        return { model: next }
      }

      const requests = Requests.fail(model.requests, request, error)

      const mergedErrors = Record.isEmptyRecord(fieldErrors)
        ? model.fieldErrors
        : Record.union(model.fieldErrors, fieldErrors, (_, incoming) => incoming)

      const notice = NoticeSchema.make({ kind: "error", text: error })
      const next = ModelSchema.make({ ...model, requests, saving, fieldErrors: mergedErrors, notice })

      return { model: next }
    },
  })

  const init = () => pipe(
    ModelSchema.make({
      items: [],
      nextCursor: null,
      form: options.empty,
      selectedId: null,
      saving: null,
      requests: Requests.empty(),
      fieldErrors: FieldErrorsSchema.make({}),
      notice: null,
    }),
    reload,
  )

  const operationKey = (operation: "list" | "save" | "remove") => pipe(
    Match.value(operation),
    Match.when("list", Function.constant(listKey)),
    Match.when("save", Function.constant(saveKey)),
    Match.when("remove", Function.constant(removeKey)),
    Match.exhaustive,
  )

  const pending = (model: Model, operation: "list" | "save" | "remove") => {
    const key = operationKey(operation)
    return Requests.pending(model.requests, key)
  }

  return { Client, Model: ModelSchema, Message: MessageSchema, init, update, pending }
}

export const ResourceEditor = { make }
