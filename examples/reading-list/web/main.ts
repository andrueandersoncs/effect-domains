import { Array, Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
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
import { rpcCall } from "@effect-domains/example-web/rpc"
import {
  BookFormatSchema,
  RatingSchema,
  ReadingListBookSchema,
  ReadingStatusSchema,
} from "../domain.ts"

const BookRowSchema = Schema.Struct({
  id: Schema.String,
  title: ReadingListBookSchema.fields.title,
  author: ReadingListBookSchema.fields.author,
  status: ReadingStatusSchema,
  format: BookFormatSchema,
  rating: Schema.NullOr(RatingSchema),
  notes: Schema.NullOr(Schema.String),
})

const cursorFromUnknown = (value: unknown) => {
  if (value === null || value === undefined) return null
  if (typeof value === "string" && value.length > 0) return value
  if (typeof value === "object" && value !== null && "_tag" in value) {
    const tagged = value as { _tag: unknown; value?: unknown }
    if (tagged._tag === "Some" && typeof tagged.value === "string") return tagged.value
  }
  return null
}

const BookPageSchema = Schema.Struct({
  items: Schema.Array(BookRowSchema),
  nextCursor: Schema.Unknown,
})

const statuses = ["planned", "reading", "finished"] as const
const formats = ["paperback", "hardcover", "ebook", "audiobook"] as const
const statusChoices = [
  { value: "", label: "Any status" },
  ...Array.map(statuses, (status) => ({ value: status, label: status })),
]
const formatChoices = [
  { value: "", label: "Any format" },
  ...Array.map(formats, (format) => ({ value: format, label: format })),
]
const formStatusChoices = Array.map(statuses, (status) => ({ value: status, label: status }))
const formFormatChoices = Array.map(formats, (format) => ({ value: format, label: format }))

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
  busy: Schema.Boolean,
  notice: Schema.NullOr(Schema.Struct({
    kind: Schema.Literals(["info", "error", "success"]),
    text: Schema.String,
  })),
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
  ClickedSave: {},
  ClickedNew: {},
  ClickedSelect: { id: Schema.String },
  ClickedRemove: { id: Schema.String },
  SucceededList: { items: Schema.Array(BookRowSchema), nextCursor: Schema.NullOr(Schema.String) },
  SucceededSave: { book: BookRowSchema, created: Schema.Boolean },
  SucceededRemove: { id: Schema.String },
  Failed: { error: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message>

const emptyForm = {
  title: "",
  author: "",
  status: "planned" as const,
  format: "paperback" as const,
  rating: "",
  notes: "",
  selectedId: null as string | null,
}


export const ListBooks = Command.define("ListBooks", {
  args: {
    filterStatus: Schema.String,
    filterFormat: Schema.String,
  },
  messages: [Message.SucceededList, Message.Failed],
  execute: ({ filterStatus, filterFormat }) =>
    pipe(
      rpcCall({
        tag: "books.list",
        payload: {
          filter: {
            ...(filterStatus === "" ? {} : { status: filterStatus }),
            ...(filterFormat === "" ? {} : { format: filterFormat }),
          },
          limit: 25,
        },
        token: null,
        success: BookPageSchema,
      }),
      Effect.match({
        onSuccess: (page) => Message.SucceededList({
          items: page.items,
          nextCursor: cursorFromUnknown(page.nextCursor),
        }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const SaveBook = Command.define("SaveBook", {
  args: {
    selectedId: Schema.NullOr(Schema.String),
    title: Schema.String,
    author: Schema.String,
    status: ReadingStatusSchema,
    format: BookFormatSchema,
    rating: Schema.String,
    notes: Schema.String,
  },
  messages: [Message.SucceededSave, Message.Failed],
  execute: (args) => {
    const rating = args.rating.trim() === "" ? null : Number.parseInt(args.rating, 10)
    const notes = args.notes.trim() === "" ? null : args.notes.trim()
    const book = {
      title: args.title.trim(),
      author: args.author.trim(),
      status: args.status,
      format: args.format,
      rating,
      notes,
    }
    const creating = args.selectedId === null
    return pipe(
      rpcCall({
        tag: creating ? "books.create" : "books.update",
        payload: creating ? book : { id: args.selectedId, ...book },
        token: null,
        success: BookRowSchema,
      }),
      Effect.match({
        onSuccess: (saved) => Message.SucceededSave({ book: saved, created: creating }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    )
  },
})

export const RemoveBook = Command.define("RemoveBook", {
  args: { id: Schema.String },
  messages: [Message.SucceededRemove, Message.Failed],
  execute: ({ id }) =>
    pipe(
      rpcCall({
        tag: "books.remove",
        payload: { id },
        token: null,
        success: Schema.Unknown,
      }),
      Effect.match({
        onSuccess: () => Message.SucceededRemove({ id }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

const reload = (model: Model) => ListBooks({
  filterStatus: model.filterStatus,
  filterFormat: model.filterFormat,
})

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedFilterStatus: ({ value }) => {
      const next = evo(model, { filterStatus: () => value, busy: () => true })
      return { model: next, commands: [reload(next)] }
    },
    ChangedFilterFormat: ({ value }) => {
      const next = evo(model, { filterFormat: () => value, busy: () => true })
      return { model: next, commands: [reload(next)] }
    },
    ChangedTitle: ({ value }) => ({ model: evo(model, { title: () => value }) }),
    ChangedAuthor: ({ value }) => ({ model: evo(model, { author: () => value }) }),
    ChangedStatus: ({ value }) => ({
      model: evo(model, { status: () => value as Model["status"] }),
    }),
    ChangedFormat: ({ value }) => ({
      model: evo(model, { format: () => value as Model["format"] }),
    }),
    ChangedRating: ({ value }) => ({ model: evo(model, { rating: () => value }) }),
    ChangedNotes: ({ value }) => ({ model: evo(model, { notes: () => value }) }),
    ClickedReload: () => ({
      model: evo(model, { busy: () => true }),
      commands: [reload(model)],
    }),
    ClickedSave: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [SaveBook({
        selectedId: model.selectedId,
        title: model.title,
        author: model.author,
        status: model.status,
        format: model.format,
        rating: model.rating,
        notes: model.notes,
      })],
    }),
    ClickedNew: () => ({
      model: evo(model, {
        title: () => "",
        author: () => "",
        status: () => "planned",
        format: () => "paperback",
        rating: () => "",
        notes: () => "",
        selectedId: () => null,
        notice: () => null,
      }),
    }),
    ClickedSelect: ({ id }) =>
      Option.match(Array.findFirst(model.books, (item) => item.id === id), {
        onNone: () => ({ model }),
        onSome: (book) => ({
          model: evo(model, {
            selectedId: () => book.id,
            title: () => book.title,
            author: () => book.author,
            status: () => book.status,
            format: () => book.format,
            rating: () => book.rating === null ? "" : String(book.rating),
            notes: () => book.notes ?? "",
            notice: () => null,
          }),
        }),
      }),
    ClickedRemove: ({ id }) => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [RemoveBook({ id })],
    }),
    SucceededList: ({ items, nextCursor }) => ({
      model: evo(model, {
        books: () => items,
        nextCursor: () => nextCursor,
        busy: () => false,
      }),
    }),
    SucceededSave: ({ book, created }) => ({
      model: evo(model, {
        selectedId: () => book.id,
        title: () => book.title,
        author: () => book.author,
        status: () => book.status,
        format: () => book.format,
        rating: () => book.rating === null ? "" : String(book.rating),
        notes: () => book.notes ?? "",
        busy: () => true,
        notice: () => ({ kind: "success" as const, text: created ? "Added to the list." : "Updated." }),
      }),
      commands: [ListBooks({ filterStatus: model.filterStatus, filterFormat: model.filterFormat })],
    }),
    SucceededRemove: ({ id }) => ({
      model: evo(model, {
        busy: () => true,
        title: () => model.selectedId === id ? "" : model.title,
        author: () => model.selectedId === id ? "" : model.author,
        status: () => model.selectedId === id ? "planned" : model.status,
        format: () => model.selectedId === id ? "paperback" : model.format,
        rating: () => model.selectedId === id ? "" : model.rating,
        notes: () => model.selectedId === id ? "" : model.notes,
        selectedId: () => model.selectedId === id ? null : model.selectedId,
        notice: () => ({ kind: "success" as const, text: "Removed." }),
      }),
      commands: [ListBooks({ filterStatus: model.filterStatus, filterFormat: model.filterFormat })],
    }),
    Failed: ({ error }) => ({
      model: evo(model, {
        busy: () => false,
        notice: () => ({ kind: "error" as const, text: error }),
      }),
    }),
  })

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    books: [],
    nextCursor: null,
    filterStatus: "",
    filterFormat: "",
    ...emptyForm,
    busy: true,
    notice: null,
  },
  commands: [ListBooks({ filterStatus: "", filterFormat: "" })],
})

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Reading list",
  body: shell(h, {
    title: "Reading list",
    lede: "Keep a personal backlog, record progress, and rate finished books. This page talks to the same published RPC as the CLI.",
    notice: model.notice,
    session: null,
    children: [
      h.div(
        [h.Class("split")],
        [
          h.section(
            [h.Class("panel stack")],
            [
              h.div(
                [h.Class("actions")],
                [
                  field(h, {
                    id: "filter-status",
                    label: "Status",
                    children: selectInput(h, {
                      id: "filter-status",
                      value: model.filterStatus,
                      onChange: (value) => Message.ChangedFilterStatus({ value }),
                      choices: statusChoices,
                    }),
                  }),
                  field(h, {
                    id: "filter-format",
                    label: "Format",
                    children: selectInput(h, {
                      id: "filter-format",
                      value: model.filterFormat,
                      onChange: (value) => Message.ChangedFilterFormat({ value }),
                      choices: formatChoices,
                    }),
                  }),
                  primaryButton(h, {
                    label: model.busy ? "Loading…" : "Reload",
                    message: Option.some(Message.ClickedReload()),
                    type: "button",
                    disabled: model.busy,
                  }),
                ],
              ),
              dataTable(h, {
                caption: "Books",
                columns: ["Title", "Author", "Status", "Format", "Rating", ""],
                rows: model.books,
                key: (book) => book.id,
                cells: (book) => [
                  book.title,
                  book.author,
                  book.status,
                  book.format,
                  book.rating === null ? "—" : String(book.rating),
                  h.div(
                    [h.Class("row-actions")],
                    [
                      quietButton(h, { label: "Edit", message: Message.ClickedSelect({ id: book.id }), disabled: false }),
                      quietButton(h, { label: "Remove", message: Message.ClickedRemove({ id: book.id }), disabled: model.busy }),
                    ],
                  ),
                ],
              }),
            ],
          ),
          h.section(
            [h.Class("panel")],
            [
              h.form(
                [h.Class("stack"), h.OnSubmit(Message.ClickedSave())],
                [
                  h.h2([], [model.selectedId === null ? "Add a book" : "Edit book"]),
                  field(h, {
                    id: "title",
                    label: "Title",
                    children: textInput(h, {
                      id: "title",
                      value: model.title,
                      onInput: (value) => Message.ChangedTitle({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "author",
                    label: "Author",
                    children: textInput(h, {
                      id: "author",
                      value: model.author,
                      onInput: (value) => Message.ChangedAuthor({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "status",
                    label: "Status",
                    children: selectInput(h, {
                      id: "status",
                      value: model.status,
                      onChange: (value) => Message.ChangedStatus({ value }),
                      choices: formStatusChoices,
                    }),
                  }),
                  field(h, {
                    id: "format",
                    label: "Format",
                    children: selectInput(h, {
                      id: "format",
                      value: model.format,
                      onChange: (value) => Message.ChangedFormat({ value }),
                      choices: formFormatChoices,
                    }),
                  }),
                  field(h, {
                    id: "rating",
                    label: "Rating (1–5)",
                    children: textInput(h, {
                      id: "rating",
                      value: model.rating,
                      type: "number",
                      placeholder: "",
                      autocomplete: "off",
                      onInput: (value) => Message.ChangedRating({ value }),
                    }),
                  }),
                  field(h, {
                    id: "notes",
                    label: "Notes",
                    children: textareaInput(h, {
                      id: "notes",
                      value: model.notes,
                      rows: 4,
                      onInput: (value) => Message.ChangedNotes({ value }),
                    }),
                  }),
                  h.div(
                    [h.Class("actions")],
                    [
                      primaryButton(h, {
                        label: model.selectedId === null ? "Add book" : "Save changes",
                        message: Option.none(),
                        type: "submit",
                        disabled: model.busy,
                      }),
                      quietButton(h, { label: "Clear", message: Message.ClickedNew(), disabled: false }),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  }),
})
