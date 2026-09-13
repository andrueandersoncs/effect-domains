import { Array, Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import {
  dataTable,
  field,
  primaryButton,
  quietButton,
  selectInput,
  shell,
  textInput,
  textareaInput,
} from "@effect-domains/example-web/html"
import { Form } from "effect-domains/form"
import { Page } from "effect-domains/page"
import { ResourcePager } from "effect-domains/resource-pager"
import { Requests, RequestStateSchema, RequestTokenSchema, type RequestToken } from "effect-domains/requests"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { BookFormatSchema, RatingSchema, ReadingListBookSchema, ReadingStatusSchema } from "../domain.ts"
import { ReadingListResource } from "../resources.ts"

const BookRowSchema = ReadingListResource.table.rowSchema
const BookPageSchema = ReadingListResource.contracts.list.successSchema
export const WebClient = RpcService.make({ name: "reading-list/WebClient", group: ReadingListResource.group })
export type WebClient = Type<typeof WebClient>

const statuses = ["planned", "reading", "finished"] as const
const formats = ["paperback", "hardcover", "ebook", "audiobook"] as const
const statusChoices = [{ value: "", label: "Any status" }, ...Array.map(statuses, (value) => ({ value, label: value }))]
const formatChoices = [{ value: "", label: "Any format" }, ...Array.map(formats, (value) => ({ value, label: value }))]
const formStatusChoices = Array.map(statuses, (value) => ({ value, label: value }))
const formFormatChoices = Array.map(formats, (value) => ({ value, label: value }))

export const Model = Schema.Struct({
  books: Schema.Array(BookRowSchema),
  nextCursor: Schema.NullOr(Schema.String),
  filterStatus: Schema.String,
  filterFormat: Schema.String,
  title: Schema.String,
  author: Schema.String,
  status: ReadingStatusSchema,
  format: BookFormatSchema,
  rating: Schema.String,
  notes: Schema.String,
  selectedId: Schema.NullOr(Schema.String),
  requests: RequestStateSchema,
  fieldErrors: Schema.Record(Schema.String, Schema.String),
  notice: Schema.NullOr(Schema.Struct({ kind: Schema.Literals(["info", "error", "success"]), text: Schema.String })),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedFilterStatus: { value: Schema.String },
  ChangedFilterFormat: { value: Schema.String },
  ChangedTitle: { value: Schema.String },
  ChangedAuthor: { value: Schema.String },
  ChangedStatus: { value: Schema.String },
  ChangedFormat: { value: Schema.String },
  ChangedRating: { value: Schema.String },
  ChangedNotes: { value: Schema.String },
  ClickedReload: {},
  ClickedNext: {},
  ClickedSave: {},
  ClickedNew: {},
  ClickedSelect: { id: Schema.String },
  ClickedRemove: { id: Schema.String },
  SucceededList: { page: BookPageSchema, append: Schema.Boolean, request: RequestTokenSchema },
  SucceededSave: { book: BookRowSchema, created: Schema.Boolean, request: RequestTokenSchema },
  SucceededRemove: { id: Schema.String, request: RequestTokenSchema },
  Failed: { request: RequestTokenSchema, error: Schema.String, field: Schema.NullOr(Schema.String) },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient>

type FormFailure = Readonly<{ _tag: "FormFailure"; field: string; error: string }>
const formFailure = (field: string) => (error: Schema.SchemaError): FormFailure => ({
  _tag: "FormFailure",
  field,
  error: Form.errors(error)["$"] ?? error.message,
})
const isFormFailure = (error: unknown): error is FormFailure =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "FormFailure"
const failed = (request: RequestToken, error: unknown) => Message.Failed({
  request,
  error: isFormFailure(error) ? error.error : RpcBrowser.messageFromUnknown(error),
  field: isFormFailure(error) ? error.field : null,
})

const emptyForm = { title: "", author: "", status: "planned" as const, format: "paperback" as const, rating: "", notes: "", selectedId: null as string | null }

export const ListBooks = Command.define("ListBooks", {
  args: { filterStatus: Schema.String, filterFormat: Schema.String, cursor: Schema.NullOr(Schema.String), append: Schema.Boolean, request: RequestTokenSchema },
  messages: [Message.SucceededList, Message.Failed],
  execute: (args) => Effect.gen(function*() {
    const client = yield* WebClient
    const page = yield* client["books.list"]({
      filter: {
        ...(args.filterStatus === "" ? {} : { status: args.filterStatus as typeof ReadingStatusSchema.Type }),
        ...(args.filterFormat === "" ? {} : { format: args.filterFormat as typeof BookFormatSchema.Type }),
      },
      limit: 25,
      ...Page.input(args.cursor),
    })
    return Message.SucceededList({ page, append: args.append, request: args.request })
  }).pipe(Effect.catch((error) => Effect.succeed(failed(args.request, error)))),
})

export const SaveBook = Command.define("SaveBook", {
  args: { selectedId: Schema.NullOr(Schema.String), title: Schema.String, author: Schema.String, status: ReadingStatusSchema, format: BookFormatSchema, rating: Schema.String, notes: Schema.String, request: RequestTokenSchema },
  messages: [Message.SucceededSave, Message.Failed],
  execute: (args) => Effect.gen(function*() {
    const title = yield* Schema.decodeUnknownEffect(ReadingListBookSchema.fields.title)(args.title.trim()).pipe(Effect.mapError(formFailure("title")))
    const author = yield* Schema.decodeUnknownEffect(ReadingListBookSchema.fields.author)(args.author.trim()).pipe(Effect.mapError(formFailure("author")))
    const rating = args.rating.trim() === ""
      ? null
      : yield* Schema.decodeUnknownEffect(Form.integer(RatingSchema))(args.rating).pipe(Effect.mapError(formFailure("rating")))
    const notes = yield* Schema.decodeUnknownEffect(Form.nullableText(Schema.NonEmptyString))(args.notes).pipe(Effect.mapError(formFailure("notes")))
    const client = yield* WebClient
    const book = { title, author, status: args.status, format: args.format, rating, notes }
    const created = args.selectedId === null
    const saved = yield* (created ? client["books.create"](book) : client["books.update"]({ id: args.selectedId, ...book }))
    return Message.SucceededSave({ book: saved, created, request: args.request })
  }).pipe(Effect.catch((error) => Effect.succeed(failed(args.request, error)))),
})

export const RemoveBook = Command.define("RemoveBook", {
  args: { id: Schema.String, request: RequestTokenSchema },
  messages: [Message.SucceededRemove, Message.Failed],
  execute: ({ id, request }) => Effect.gen(function*() {
    const client = yield* WebClient
    yield* client["books.remove"]({ id })
    return Message.SucceededRemove({ id, request })
  }).pipe(Effect.catch((error) => Effect.succeed(failed(request, error)))),
})

const BooksPager = ResourcePager.make("books.list")
const pageState = (model: Model) => ({
  page: { items: model.books, nextCursor: model.nextCursor },
  requests: model.requests,
})
const listCommand = (model: Model, request: RequestToken, cursor: string | null, append: boolean) =>
  ListBooks({ filterStatus: model.filterStatus, filterFormat: model.filterFormat, cursor, append, request })
const beginList = (model: Model, append: boolean) => {
  const started = pipe(BooksPager.begin(model.requests, pageState(model).page, append), Option.getOrThrow)
  return {
    page: started.page,
    state: started.requests,
    command: listCommand(model, started.request, started.cursor, started.append),
  }
}
const begin = (model: Model, key: string) => Requests.start(model.requests, key)
const withError = <M>(h: HtmlBuilder<M>, child: Html, error: string | undefined) =>
  h.div([], [child, error === undefined ? h.empty : h.p([h.Class("field-error")], [error])])

export const update = (model: Model, message: Message) => Message.match<UpdateReturn>(message, {
  ChangedFilterStatus: ({ value }) => {
    const next = evo(model, { filterStatus: () => value })
    const listing = beginList(next, false)
    return { model: evo(next, { books: () => listing.page.items, nextCursor: () => listing.page.nextCursor, requests: () => listing.state, notice: () => null }), commands: [listing.command] }
  },
  ChangedFilterFormat: ({ value }) => {
    const next = evo(model, { filterFormat: () => value })
    const listing = beginList(next, false)
    return { model: evo(next, { books: () => listing.page.items, nextCursor: () => listing.page.nextCursor, requests: () => listing.state, notice: () => null }), commands: [listing.command] }
  },
  ChangedTitle: ({ value }) => ({ model: evo(model, { title: () => value }) }),
  ChangedAuthor: ({ value }) => ({ model: evo(model, { author: () => value }) }),
  ChangedStatus: ({ value }) => ({ model: evo(model, { status: () => value as Model["status"] }) }),
  ChangedFormat: ({ value }) => ({ model: evo(model, { format: () => value as Model["format"] }) }),
  ChangedRating: ({ value }) => ({ model: evo(model, { rating: () => value }) }),
  ChangedNotes: ({ value }) => ({ model: evo(model, { notes: () => value }) }),
  ClickedReload: () => {
    const listing = beginList(model, false)
    return { model: evo(model, { books: () => listing.page.items, nextCursor: () => listing.page.nextCursor, requests: () => listing.state, notice: () => null }), commands: [listing.command] }
  },
  ClickedNext: () => {
    if (model.nextCursor === null || BooksPager.pending(model.requests)) return { model }
    const listing = beginList(model, true)
    return { model: evo(model, { books: () => listing.page.items, nextCursor: () => listing.page.nextCursor, requests: () => listing.state }), commands: [listing.command] }
  },
  ClickedSave: () => {
    const started = begin(model, "books.save")
    return { model: evo(model, { requests: () => started.state, fieldErrors: () => ({}), notice: () => null }), commands: [SaveBook({ ...model, request: started.request })] }
  },
  ClickedNew: () => ({ model: evo(model, { title: () => "", author: () => "", status: () => "planned", format: () => "paperback", rating: () => "", notes: () => "", selectedId: () => null, fieldErrors: () => ({}), notice: () => null }) }),
  ClickedSelect: ({ id }) => Option.match(Array.findFirst(model.books, (book) => book.id === id), {
    onNone: () => ({ model }),
    onSome: (book) => ({ model: evo(model, { selectedId: () => book.id, title: () => book.title, author: () => book.author, status: () => book.status, format: () => book.format, rating: () => book.rating === null ? "" : String(book.rating), notes: () => book.notes ?? "", fieldErrors: () => ({}), notice: () => null }) }),
  }),
  ClickedRemove: ({ id }) => {
    const started = begin(model, "books.remove")
    return { model: evo(model, { requests: () => started.state, notice: () => null }), commands: [RemoveBook({ id, request: started.request })] }
  },
  SucceededList: ({ page, append, request }) => Option.match(
    BooksPager.receive(pageState(model), request, page, append),
    {
      onNone: () => ({ model }),
      onSome: (received) => ({ model: evo(model, {
        books: () => received.page.items,
        nextCursor: () => received.page.nextCursor,
        requests: () => received.requests,
      }) }),
    },
  ),
  SucceededSave: ({ book, created, request }) => {
    if (!Requests.accepts(model.requests, request)) return { model }
    const listing = beginList(evo(model, { requests: () => Requests.succeed(model.requests, request) }), false)
    return { model: evo(model, { selectedId: () => book.id, title: () => book.title, author: () => book.author, status: () => book.status, format: () => book.format, rating: () => book.rating === null ? "" : String(book.rating), notes: () => book.notes ?? "", books: () => listing.page.items, nextCursor: () => listing.page.nextCursor, requests: () => listing.state, notice: () => ({ kind: "success" as const, text: created ? "Added to the list." : "Updated." }) }), commands: [listing.command] }
  },
  SucceededRemove: ({ id, request }) => {
    if (!Requests.accepts(model.requests, request)) return { model }
    const base = evo(model, { requests: () => Requests.succeed(model.requests, request) })
    const listing = beginList(base, false)
    const selected = model.selectedId === id
    return { model: evo(model, { title: () => selected ? "" : model.title, author: () => selected ? "" : model.author, status: () => selected ? "planned" : model.status, format: () => selected ? "paperback" : model.format, rating: () => selected ? "" : model.rating, notes: () => selected ? "" : model.notes, selectedId: () => selected ? null : model.selectedId, books: () => listing.page.items, nextCursor: () => listing.page.nextCursor, requests: () => listing.state, notice: () => ({ kind: "success" as const, text: "Removed." }) }), commands: [listing.command] }
  },
  Failed: ({ request, error, field }) => {
    if (!Requests.accepts(model.requests, request)) return { model }
    return { model: evo(model, { requests: () => Requests.fail(model.requests, request, error), fieldErrors: () => field === null ? model.fieldErrors : { ...model.fieldErrors, [field]: error }, notice: () => ({ kind: "error" as const, text: error }) }) }
  },
})

export const init: Runtime.ApplicationInit<Model, Message, void, WebClient> = () => {
  const model: Model = { books: [], nextCursor: null, filterStatus: "", filterFormat: "", ...emptyForm, requests: Requests.empty(), fieldErrors: {}, notice: null }
  const listing = beginList(model, false)
  return { model: evo(model, { books: () => listing.page.items, nextCursor: () => listing.page.nextCursor, requests: () => listing.state }), commands: [listing.command] }
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Reading list",
  body: shell(h, {
    title: "Reading list",
    lede: "Keep a personal backlog, record progress, and rate finished books. This page talks to the same published RPC as the CLI.",
    notice: model.notice,
    session: null,
    children: [h.div([h.Class("split")], [
      h.section([h.Class("panel stack")], [
        h.div([h.Class("actions")], [
          field(h, { id: "filter-status", label: "Status", children: selectInput(h, { id: "filter-status", value: model.filterStatus, onChange: (value) => Message.ChangedFilterStatus({ value }), choices: statusChoices }) }),
          field(h, { id: "filter-format", label: "Format", children: selectInput(h, { id: "filter-format", value: model.filterFormat, onChange: (value) => Message.ChangedFilterFormat({ value }), choices: formatChoices }) }),
          primaryButton(h, { label: Requests.pending(model.requests, "books.list") ? "Loading…" : "Reload", message: Option.some(Message.ClickedReload()), type: "button", disabled: Requests.pending(model.requests, "books.list") }),
        ]),
        dataTable(h, { caption: "Books", columns: ["Title", "Author", "Status", "Format", "Rating", ""], rows: model.books, key: (book) => book.id, cells: (book) => [book.title, book.author, book.status, book.format, book.rating === null ? "—" : String(book.rating), h.div([h.Class("row-actions")], [quietButton(h, { label: "Edit", message: Message.ClickedSelect({ id: book.id }), disabled: false }), quietButton(h, { label: "Remove", message: Message.ClickedRemove({ id: book.id }), disabled: Requests.pending(model.requests, "books.remove") })])] }),
        model.nextCursor === null ? h.p([], ["All book pages loaded."]) : quietButton(h, { label: "Load more books", message: Message.ClickedNext(), disabled: Requests.pending(model.requests, "books.list") }),
      ]),
      h.section([h.Class("panel")], [h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSave())], [
        h.h2([], [model.selectedId === null ? "Add a book" : "Edit book"]),
        field(h, { id: "title", label: "Title", children: withError(h, textInput(h, { id: "title", value: model.title, onInput: (value) => Message.ChangedTitle({ value }), type: "text", placeholder: "", autocomplete: "off" }), model.fieldErrors.title) }),
        field(h, { id: "author", label: "Author", children: withError(h, textInput(h, { id: "author", value: model.author, onInput: (value) => Message.ChangedAuthor({ value }), type: "text", placeholder: "", autocomplete: "off" }), model.fieldErrors.author) }),
        field(h, { id: "status", label: "Status", children: selectInput(h, { id: "status", value: model.status, onChange: (value) => Message.ChangedStatus({ value }), choices: formStatusChoices }) }),
        field(h, { id: "format", label: "Format", children: selectInput(h, { id: "format", value: model.format, onChange: (value) => Message.ChangedFormat({ value }), choices: formFormatChoices }) }),
        field(h, { id: "rating", label: "Rating (1–5)", children: withError(h, textInput(h, { id: "rating", value: model.rating, type: "number", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedRating({ value }) }), model.fieldErrors.rating) }),
        field(h, { id: "notes", label: "Notes", children: withError(h, textareaInput(h, { id: "notes", value: model.notes, rows: 4, onInput: (value) => Message.ChangedNotes({ value }) }), model.fieldErrors.notes) }),
        h.div([h.Class("actions")], [primaryButton(h, { label: model.selectedId === null ? "Add book" : "Save changes", message: Option.none(), type: "submit", disabled: Requests.pending(model.requests, "books.save") }), quietButton(h, { label: "Clear", message: Message.ClickedNew(), disabled: false })]),
      ])]),
    ])],
  }),
})
