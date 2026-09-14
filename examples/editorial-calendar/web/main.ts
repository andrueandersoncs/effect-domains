import { Array, DateTime, Option, Schema } from "effect"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { dataTable, field, primaryButton, quietButton, selectInput, shell, textInput, textareaInput } from "@effect-domains/example-web/html"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { Form } from "effect-domains/form"
import { Resource } from "effect-domains/resource"
import { ResourceEditor } from "effect-domains/resource-editor"
import { ArticleSchema, EditorialChannelSchema, NonNegativePrioritySchema } from "../domain.ts"
import { DocumentsResource } from "../resources.ts"

const DocumentFormSchema = Schema.Struct({
  heading: Form.text(ArticleSchema.fields.heading),
  summary: Form.nullableText(Schema.String),
  priority: Form.integer(NonNegativePrioritySchema),
  channel: EditorialChannelSchema,
  plannedPublicationAt: Form.nullableText(Schema.DateTimeUtcFromString),
})

const Editor = ResourceEditor.make({
  name: "editorial-calendar/Documents",
  resource: Resource.compile(DocumentsResource),
  form: DocumentFormSchema,
  empty: { heading: "", summary: "", priority: "0", channel: "website", plannedPublicationAt: "" },
  notices: {
    created: "Editorial plan added.",
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

const channels = ["website", "newsletter", "print"] as const
const channelChoices = Array.map(channels, (value) => ({ value, label: value }))
const iso = (value: DateTime.Utc | null) => value === null ? "" : DateTime.formatIso(value)

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const pendingList = Editor.pending(model, "list")
  const pendingSave = Editor.pending(model, "save")
  const pendingRemove = Editor.pending(model, "remove")

  return {
    title: "Editorial calendar",
    body: shell(h, {
      title: "Editorial calendar",
      lede: "Plan articles across your website, newsletter, and print publication. This page uses the same public RPC as the CLI.",
      notice: model.notice,
      session: null,
      children: [h.div([h.Class("split")], [
        h.section([h.Class("panel stack")], [
          h.div([h.Class("actions")], [primaryButton(h, {
            label: pendingList ? "Loading…" : "Reload",
            message: Option.some(Message.ClickedReload()),
            type: "button",
            disabled: pendingList,
          })]),
          dataTable(h, {
            caption: "Planned articles",
            columns: ["Heading", "Priority", "Channel", "Publication", ""],
            rows: model.items,
            key: (document) => document.id,
            cells: (document) => [
              document.heading,
              String(document.priority),
              document.channel,
              iso(document.plannedPublicationAt) || "—",
              h.div([h.Class("row-actions")], [
                quietButton(h, { label: "Edit", message: Message.ClickedSelect({ id: document.id }), disabled: false }),
                quietButton(h, { label: "Remove", message: Message.ClickedRemove({ id: document.id }), disabled: pendingRemove }),
              ]),
            ],
          }),
          model.nextCursor === null
            ? h.p([], ["All article pages loaded."])
            : quietButton(h, { label: "Load more articles", message: Message.ClickedNext(), disabled: pendingList }),
        ]),
        h.section([h.Class("panel")], [h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSave())], [
          h.h2([], [model.selectedId === null ? "Add an article" : "Edit article"]),
          field(h, {
            id: "heading",
            label: "Heading",
            error: model.fieldErrors.heading,
            children: textInput(h, {
              id: "heading",
              value: model.form.heading,
              type: "text",
              placeholder: "",
              autocomplete: "off",
              onInput: (value) => Message.ChangedField({ key: "heading", value }),
            }),
          }),
          field(h, {
            id: "summary",
            label: "Summary",
            error: model.fieldErrors.summary,
            children: textareaInput(h, {
              id: "summary",
              value: model.form.summary,
              rows: 4,
              onInput: (value) => Message.ChangedField({ key: "summary", value }),
            }),
          }),
          field(h, {
            id: "priority",
            label: "Priority",
            error: model.fieldErrors.priority,
            children: textInput(h, {
              id: "priority",
              value: model.form.priority,
              type: "number",
              placeholder: "",
              autocomplete: "off",
              onInput: (value) => Message.ChangedField({ key: "priority", value }),
            }),
          }),
          field(h, {
            id: "channel",
            label: "Channel",
            children: selectInput(h, {
              id: "channel",
              value: model.form.channel,
              onChange: (value) => Message.ChangedField({
                key: "channel",
                value: Schema.decodeUnknownSync(EditorialChannelSchema)(value),
              }),
              choices: channelChoices,
            }),
          }),
          field(h, {
            id: "planned-publication-at",
            label: "Planned publication (ISO datetime)",
            error: model.fieldErrors.plannedPublicationAt,
            children: textInput(h, {
              id: "planned-publication-at",
              value: model.form.plannedPublicationAt,
              type: "text",
              placeholder: "2026-10-01T09:00:00.000Z",
              autocomplete: "off",
              onInput: (value) => Message.ChangedField({ key: "plannedPublicationAt", value }),
            }),
          }),
          h.div([h.Class("actions")], [
            primaryButton(h, {
              label: model.selectedId === null ? "Add article" : "Save changes",
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
