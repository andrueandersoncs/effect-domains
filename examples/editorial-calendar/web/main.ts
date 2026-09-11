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
import { ArticleSchema, EditorialChannelSchema } from "../domain.ts"

const DocumentRowSchema = Schema.Struct({
  id: Schema.String,
  heading: ArticleSchema.fields.heading,
  summary: ArticleSchema.fields.summary,
  priority: ArticleSchema.fields.priority,
  channel: EditorialChannelSchema,
  plannedPublicationAt: Schema.NullOr(Schema.String),
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

const DocumentPageSchema = Schema.Struct({
  items: Schema.Array(DocumentRowSchema),
  nextCursor: Schema.Unknown,
})

const channels = ["website", "newsletter", "print"] as const
const channelChoices = Array.map(channels, (channel) => ({ value: channel, label: channel }))

export const Model = Schema.Struct({
  documents: Schema.Array(DocumentRowSchema),
  nextCursor: Schema.NullOr(Schema.String),
  heading: Schema.String,
  summary: Schema.String,
  priority: Schema.String,
  channel: EditorialChannelSchema,
  plannedPublicationAt: Schema.String,
  selectedId: Schema.NullOr(Schema.String),
  busy: Schema.Boolean,
  notice: Schema.NullOr(Schema.Struct({
    kind: Schema.Literals(["info", "error", "success"]),
    text: Schema.String,
  })),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedHeading: { value: Schema.String },
  ChangedSummary: { value: Schema.String },
  ChangedPriority: { value: Schema.String },
  ChangedChannel: { value: Schema.String },
  ChangedPlannedPublicationAt: { value: Schema.String },
  ClickedReload: {},
  ClickedSave: {},
  ClickedNew: {},
  ClickedSelect: { id: Schema.String },
  ClickedRemove: { id: Schema.String },
  SucceededList: { items: Schema.Array(DocumentRowSchema), nextCursor: Schema.NullOr(Schema.String) },
  SucceededSave: { document: DocumentRowSchema, created: Schema.Boolean },
  SucceededRemove: { id: Schema.String },
  Failed: { error: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message>

const emptyForm = {
  heading: "",
  summary: "",
  priority: "0",
  channel: "website" as const,
  plannedPublicationAt: "",
  selectedId: null as string | null,
}

export const ListDocuments = Command.define("ListDocuments", {
  args: {},
  messages: [Message.SucceededList, Message.Failed],
  execute: () =>
    pipe(
      rpcCall({
        tag: "documents.list",
        payload: { limit: 50 },
        token: null,
        success: DocumentPageSchema,
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

export const SaveDocument = Command.define("SaveDocument", {
  args: {
    selectedId: Schema.NullOr(Schema.String),
    heading: Schema.String,
    summary: Schema.String,
    priority: Schema.String,
    channel: EditorialChannelSchema,
    plannedPublicationAt: Schema.String,
  },
  messages: [Message.SucceededSave, Message.Failed],
  execute: (args) => {
    const document = {
      heading: args.heading.trim(),
      summary: args.summary.trim() === "" ? null : args.summary.trim(),
      priority: Number(args.priority),
      channel: args.channel,
      plannedPublicationAt: args.plannedPublicationAt.trim() === "" ? null : args.plannedPublicationAt.trim(),
    }
    const creating = args.selectedId === null
    return pipe(
      rpcCall({
        tag: creating ? "documents.create" : "documents.update",
        payload: creating ? document : { id: args.selectedId, ...document },
        token: null,
        success: DocumentRowSchema,
      }),
      Effect.match({
        onSuccess: (saved) => Message.SucceededSave({ document: saved, created: creating }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    )
  },
})

export const RemoveDocument = Command.define("RemoveDocument", {
  args: { id: Schema.String },
  messages: [Message.SucceededRemove, Message.Failed],
  execute: ({ id }) =>
    pipe(
      rpcCall({
        tag: "documents.remove",
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

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedHeading: ({ value }) => ({ model: evo(model, { heading: () => value }) }),
    ChangedSummary: ({ value }) => ({ model: evo(model, { summary: () => value }) }),
    ChangedPriority: ({ value }) => ({ model: evo(model, { priority: () => value }) }),
    ChangedChannel: ({ value }) => ({
      model: evo(model, { channel: () => value as Model["channel"] }),
    }),
    ChangedPlannedPublicationAt: ({ value }) => ({
      model: evo(model, { plannedPublicationAt: () => value }),
    }),
    ClickedReload: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [ListDocuments({})],
    }),
    ClickedSave: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [SaveDocument({
        selectedId: model.selectedId,
        heading: model.heading,
        summary: model.summary,
        priority: model.priority,
        channel: model.channel,
        plannedPublicationAt: model.plannedPublicationAt,
      })],
    }),
    ClickedNew: () => ({
      model: evo(model, {
        heading: () => "",
        summary: () => "",
        priority: () => "0",
        channel: () => "website",
        plannedPublicationAt: () => "",
        selectedId: () => null,
        notice: () => null,
      }),
    }),
    ClickedSelect: ({ id }) =>
      Option.match(Array.findFirst(model.documents, (item) => item.id === id), {
        onNone: () => ({ model }),
        onSome: (document) => ({
          model: evo(model, {
            selectedId: () => document.id,
            heading: () => document.heading,
            summary: () => document.summary ?? "",
            priority: () => String(document.priority),
            channel: () => document.channel,
            plannedPublicationAt: () => document.plannedPublicationAt ?? "",
            notice: () => null,
          }),
        }),
      }),
    ClickedRemove: ({ id }) => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [RemoveDocument({ id })],
    }),
    SucceededList: ({ items, nextCursor }) => ({
      model: evo(model, {
        documents: () => items,
        nextCursor: () => nextCursor,
        busy: () => false,
      }),
    }),
    SucceededSave: ({ document, created }) => ({
      model: evo(model, {
        selectedId: () => document.id,
        heading: () => document.heading,
        summary: () => document.summary ?? "",
        priority: () => String(document.priority),
        channel: () => document.channel,
        plannedPublicationAt: () => document.plannedPublicationAt ?? "",
        busy: () => true,
        notice: () => ({ kind: "success" as const, text: created ? "Editorial plan added." : "Updated." }),
      }),
      commands: [ListDocuments({})],
    }),
    SucceededRemove: ({ id }) => ({
      model: evo(model, {
        busy: () => true,
        selectedId: () => model.selectedId === id ? null : model.selectedId,
        heading: () => model.selectedId === id ? "" : model.heading,
        summary: () => model.selectedId === id ? "" : model.summary,
        priority: () => model.selectedId === id ? "0" : model.priority,
        channel: () => model.selectedId === id ? "website" : model.channel,
        plannedPublicationAt: () => model.selectedId === id ? "" : model.plannedPublicationAt,
        notice: () => ({ kind: "success" as const, text: "Removed." }),
      }),
      commands: [ListDocuments({})],
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
    documents: [],
    nextCursor: null,
    ...emptyForm,
    busy: true,
    notice: null,
  },
  commands: [ListDocuments({})],
})

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Editorial calendar",
  body: shell(h, {
    title: "Editorial calendar",
    lede: "Plan articles across your website, newsletter, and print publication. This page uses the same public RPC as the CLI.",
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
                  primaryButton(h, {
                    label: model.busy ? "Loading…" : "Reload",
                    message: Option.some(Message.ClickedReload()),
                    type: "button",
                    disabled: model.busy,
                  }),
                ],
              ),
              dataTable(h, {
                caption: "Planned articles",
                columns: ["Heading", "Priority", "Channel", "Publication", ""],
                rows: model.documents,
                key: (document) => document.id,
                cells: (document) => [
                  document.heading,
                  String(document.priority),
                  document.channel,
                  document.plannedPublicationAt ?? "—",
                  h.div(
                    [h.Class("row-actions")],
                    [
                      quietButton(h, {
                        label: "Edit",
                        message: Message.ClickedSelect({ id: document.id }),
                        disabled: false,
                      }),
                      quietButton(h, {
                        label: "Remove",
                        message: Message.ClickedRemove({ id: document.id }),
                        disabled: model.busy,
                      }),
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
                  h.h2([], [model.selectedId === null ? "Add an article" : "Edit article"]),
                  field(h, {
                    id: "heading",
                    label: "Heading",
                    children: textInput(h, {
                      id: "heading",
                      value: model.heading,
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                      onInput: (value) => Message.ChangedHeading({ value }),
                    }),
                  }),
                  field(h, {
                    id: "summary",
                    label: "Summary",
                    children: textareaInput(h, {
                      id: "summary",
                      value: model.summary,
                      rows: 4,
                      onInput: (value) => Message.ChangedSummary({ value }),
                    }),
                  }),
                  field(h, {
                    id: "priority",
                    label: "Priority",
                    children: textInput(h, {
                      id: "priority",
                      value: model.priority,
                      type: "number",
                      placeholder: "",
                      autocomplete: "off",
                      onInput: (value) => Message.ChangedPriority({ value }),
                    }),
                  }),
                  field(h, {
                    id: "channel",
                    label: "Channel",
                    children: selectInput(h, {
                      id: "channel",
                      value: model.channel,
                      onChange: (value) => Message.ChangedChannel({ value }),
                      choices: channelChoices,
                    }),
                  }),
                  field(h, {
                    id: "planned-publication-at",
                    label: "Planned publication (ISO datetime)",
                    children: textInput(h, {
                      id: "planned-publication-at",
                      value: model.plannedPublicationAt,
                      type: "text",
                      placeholder: "2026-10-01T09:00:00.000Z",
                      autocomplete: "off",
                      onInput: (value) => Message.ChangedPlannedPublicationAt({ value }),
                    }),
                  }),
                  h.div(
                    [h.Class("actions")],
                    [
                      primaryButton(h, {
                        label: model.selectedId === null ? "Add article" : "Save changes",
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
