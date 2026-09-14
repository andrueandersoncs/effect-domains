import { Array, Option, Schema, SchemaGetter, pipe } from "effect"
import { type Document, type HtmlBuilder } from "foldkit/html"
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
import { Resource } from "effect-domains/resource"
import { ResourceEditor } from "effect-domains/resource-editor"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { BookFormatSchema, RatingSchema, ReadingListBookSchema, ReadingStatusSchema } from "../domain.ts"
import { ReadingListResource } from "../resources.ts"

const statuses = ["planned", "reading", "finished"] as const
const formats = ["paperback", "hardcover", "ebook", "audiobook"] as const
const StatusFilterSchema = Schema.Literals(["", ...statuses])
const FormatFilterSchema = Schema.Literals(["", ...formats])
const statusChoices = [{ value: "", label: "Any status" }, ...Array.map(statuses, (value) => ({ value, label: value }))]
const formatChoices = [{ value: "", label: "Any format" }, ...Array.map(formats, (value) => ({ value, label: value }))]
const formStatusChoices = Array.map(statuses, (value) => ({ value, label: value }))
const formFormatChoices = Array.map(formats, (value) => ({ value, label: value }))

const BookFormSchema = Schema.Struct({
  title: Form.text(ReadingListBookSchema.fields.title),
  author: Form.text(ReadingListBookSchema.fields.author),
  status: ReadingStatusSchema,
  format: BookFormatSchema,
  rating: Form.nullableInteger(RatingSchema),
  notes: Form.nullableText(Schema.NonEmptyString),
})

const BookQueryFormSchema = Schema.Struct({
  status: StatusFilterSchema,
  format: FormatFilterSchema,
})

const BookQueryInputSchema = Schema.Struct({
  filter: Schema.Struct({
    status: Schema.optionalKey(ReadingStatusSchema),
    format: Schema.optionalKey(BookFormatSchema),
  }),
  limit: Schema.Literal(25),
})

const queryInput = (form: typeof BookQueryFormSchema.Type): typeof BookQueryInputSchema.Type => ({
  filter: {
    ...(form.status === "" ? {} : { status: form.status }),
    ...(form.format === "" ? {} : { format: form.format }),
  },
  limit: 25,
})

const queryForm = (input: typeof BookQueryInputSchema.Type): typeof BookQueryFormSchema.Type => ({
  status: input.filter.status ?? "",
  format: input.filter.format ?? "",
})

const BookQuerySchema = pipe(
  BookQueryFormSchema,
  Schema.decodeTo(BookQueryInputSchema, {
    decode: SchemaGetter.transform(queryInput),
    encode: SchemaGetter.transform(queryForm),
  }),
)

const Editor = ResourceEditor.make({
  name: "reading-list/Books",
  resource: Resource.compile(ReadingListResource),
  form: BookFormSchema,
  empty: {
    title: "",
    author: "",
    status: "planned",
    format: "paperback",
    rating: "",
    notes: "",
  },
  query: {
    form: BookQuerySchema,
    empty: { status: "", format: "" },
  },
  notices: {
    created: "Added to the list.",
    updated: "Updated.",
    removed: "Removed.",
  },
  formatError: RpcBrowser.messageFromUnknown,
})

export const WebClient = Editor.Client
export const Model = Editor.Model
export type Model = typeof Model.Type
export const Message = Editor.Message
export type Message = typeof Message.Type
export const update = Editor.update
export const init = Editor.init
export const subscriptions = Editor.subscriptions

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const pendingList = Editor.pending(model, "list")
  const pendingSave = Editor.pending(model, "save")
  const pendingRemove = Editor.pending(model, "remove")

  return {
    title: "Reading list",
    body: shell(h, {
      title: "Reading list",
      lede: "Keep a personal backlog, record progress, and rate finished books. This page talks to the same published RPC as the CLI.",
      notice: model.notice,
      session: null,
      children: [h.div([h.Class("split")], [
        h.section([h.Class("panel stack")], [
          h.div([h.Class("actions")], [
            field(h, {
              id: "filter-status",
              label: "Status",
              children: selectInput(h, {
                id: "filter-status",
                value: model.query.status,
                onChange: (value) => Message.ChangedQueryField({ key: "status", value }),
                choices: statusChoices,
              }),
            }),
            field(h, {
              id: "filter-format",
              label: "Format",
              children: selectInput(h, {
                id: "filter-format",
                value: model.query.format,
                onChange: (value) => Message.ChangedQueryField({ key: "format", value }),
                choices: formatChoices,
              }),
            }),
            primaryButton(h, {
              label: pendingList ? "Loading…" : "Reload",
              message: Option.some(Message.ClickedReload()),
              type: "button",
              disabled: pendingList,
            }),
          ]),
          dataTable(h, {
            caption: "Books",
            columns: ["Title", "Author", "Status", "Format", "Rating", ""],
            rows: model.items,
            key: (book) => book.id,
            cells: (book) => [
              book.title,
              book.author,
              book.status,
              book.format,
              book.rating === null ? "—" : String(book.rating),
              h.div([h.Class("row-actions")], [
                quietButton(h, { label: "Edit", message: Message.ClickedSelect({ id: book.id }), disabled: false }),
                quietButton(h, { label: "Remove", message: Message.ClickedRemove({ id: book.id }), disabled: pendingRemove }),
              ]),
            ],
          }),
          model.nextCursor === null
            ? h.p([], ["All book pages loaded."])
            : quietButton(h, { label: "Load more books", message: Message.ClickedNext(), disabled: pendingList }),
        ]),
        h.section([h.Class("panel")], [h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSave())], [
          h.h2([], [model.selectedId === null ? "Add a book" : "Edit book"]),
          field(h, {
            id: "title",
            label: "Title",
            error: model.fieldErrors.title,
            children: textInput(h, {
              id: "title",
              value: model.form.title,
              onInput: (value) => Message.ChangedField({ key: "title", value }),
              type: "text",
              placeholder: "",
              autocomplete: "off",
            }),
          }),
          field(h, {
            id: "author",
            label: "Author",
            error: model.fieldErrors.author,
            children: textInput(h, {
              id: "author",
              value: model.form.author,
              onInput: (value) => Message.ChangedField({ key: "author", value }),
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
              value: model.form.status,
              onChange: (value) => Message.ChangedField({ key: "status", value }),
              choices: formStatusChoices,
            }),
          }),
          field(h, {
            id: "format",
            label: "Format",
            children: selectInput(h, {
              id: "format",
              value: model.form.format,
              onChange: (value) => Message.ChangedField({ key: "format", value }),
              choices: formFormatChoices,
            }),
          }),
          field(h, {
            id: "rating",
            label: "Rating (1–5)",
            error: model.fieldErrors.rating,
            children: textInput(h, {
              id: "rating",
              value: model.form.rating,
              type: "number",
              placeholder: "",
              autocomplete: "off",
              onInput: (value) => Message.ChangedField({ key: "rating", value }),
            }),
          }),
          field(h, {
            id: "notes",
            label: "Notes",
            error: model.fieldErrors.notes,
            children: textareaInput(h, {
              id: "notes",
              value: model.form.notes,
              rows: 4,
              onInput: (value) => Message.ChangedField({ key: "notes", value }),
            }),
          }),
          h.div([h.Class("actions")], [
            primaryButton(h, {
              label: model.selectedId === null ? "Add book" : "Save changes",
              message: Option.none(),
              type: "submit",
              disabled: pendingSave,
            }),
            quietButton(h, { label: "Clear", message: Message.ClickedNew(), disabled: false }),
          ]),
        ])]),
      ])],
    }),
  }
}
