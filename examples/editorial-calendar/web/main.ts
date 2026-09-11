import { Array, DateTime, Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import { dataTable, field, primaryButton, quietButton, selectInput, shell, textInput, textareaInput } from "@effect-domains/example-web/html"
import { Form } from "@effect-domains/example-web/form"
import { Page } from "@effect-domains/example-web/page"
import { Requests, RequestStateSchema, RequestTokenSchema, type RequestToken } from "@effect-domains/example-web/requests"
import { formatRpcError } from "@effect-domains/example-web/rpc"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { ArticleSchema, EditorialChannelSchema, NonNegativePrioritySchema } from "../domain.ts"
import { DocumentsResource } from "../resources.ts"

const DocumentRowSchema = DocumentsResource.table.rowSchema
const DocumentPageSchema = Page.schema(DocumentRowSchema)
export const WebClient = RpcService.make({ name: "editorial-calendar/WebClient", group: DocumentsResource.group })
export type WebClient = Type<typeof WebClient>

const channels = ["website", "newsletter", "print"] as const
const channelChoices = Array.map(channels, (value) => ({ value, label: value }))
export const Model = Schema.Struct({
  documents: Schema.Array(DocumentRowSchema), nextCursor: Schema.NullOr(Schema.String),
  heading: Schema.String, summary: Schema.String, priority: Schema.String, channel: EditorialChannelSchema, plannedPublicationAt: Schema.String, selectedId: Schema.NullOr(Schema.String),
  requests: RequestStateSchema, fieldErrors: Schema.Record(Schema.String, Schema.String),
  notice: Schema.NullOr(Schema.Struct({ kind: Schema.Literals(["info", "error", "success"]), text: Schema.String })),
})
export type Model = typeof Model.Type
export const Message = defineMessageUnion({
  ChangedHeading: { value: Schema.String }, ChangedSummary: { value: Schema.String }, ChangedPriority: { value: Schema.String }, ChangedChannel: { value: Schema.String }, ChangedPlannedPublicationAt: { value: Schema.String },
  ClickedReload: {}, ClickedNext: {}, ClickedSave: {}, ClickedNew: {}, ClickedSelect: { id: Schema.String }, ClickedRemove: { id: Schema.String },
  SucceededList: { page: DocumentPageSchema, append: Schema.Boolean, request: RequestTokenSchema },
  SucceededSave: { document: DocumentRowSchema, created: Schema.Boolean, request: RequestTokenSchema },
  SucceededRemove: { id: Schema.String, request: RequestTokenSchema },
  Failed: { request: RequestTokenSchema, error: Schema.String, field: Schema.NullOr(Schema.String) },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient>
type FormFailure = Readonly<{ _tag: "FormFailure"; field: string; error: string }>
const formFailure = (field: string) => (error: Schema.SchemaError): FormFailure => ({ _tag: "FormFailure", field, error: Form.errors(error)["$"] ?? error.message })
const isFormFailure = (error: unknown): error is FormFailure => typeof error === "object" && error !== null && "_tag" in error && error._tag === "FormFailure"
const failed = (request: RequestToken, error: unknown) => Message.Failed({ request, error: isFormFailure(error) ? error.error : formatRpcError(error), field: isFormFailure(error) ? error.field : null })
const iso = (value: DateTime.Utc | null) => value === null ? "" : DateTime.formatIso(value)
const withError = <M>(h: HtmlBuilder<M>, child: Html, error: string | undefined) => h.div([], [child, error === undefined ? h.empty : h.p([h.Class("field-error")], [error])])

export const ListDocuments = Command.define("ListDocuments", {
  args: { cursor: Schema.NullOr(Schema.String), append: Schema.Boolean, request: RequestTokenSchema }, messages: [Message.SucceededList, Message.Failed],
  execute: (args) => Effect.gen(function*() {
    const client = yield* WebClient
    const page = yield* client["documents.list"]({ limit: 50, ...Page.input(args.cursor) })
    return Message.SucceededList({ page, append: args.append, request: args.request })
  }).pipe(Effect.catch((error) => Effect.succeed(failed(args.request, error)))),
})
export const SaveDocument = Command.define("SaveDocument", {
  args: { selectedId: Schema.NullOr(Schema.String), heading: Schema.String, summary: Schema.String, priority: Schema.String, channel: EditorialChannelSchema, plannedPublicationAt: Schema.String, request: RequestTokenSchema }, messages: [Message.SucceededSave, Message.Failed],
  execute: (args) => Effect.gen(function*() {
    const heading = yield* Schema.decodeUnknownEffect(ArticleSchema.fields.heading)(args.heading.trim()).pipe(Effect.mapError(formFailure("heading")))
    const summary = yield* Schema.decodeUnknownEffect(Form.nullableText(Schema.String))(args.summary).pipe(Effect.mapError(formFailure("summary")))
    const priority = yield* Schema.decodeUnknownEffect(Form.integer(NonNegativePrioritySchema))(args.priority).pipe(Effect.mapError(formFailure("priority")))
    const plannedText = yield* Schema.decodeUnknownEffect(Form.nullableText(Schema.String))(args.plannedPublicationAt).pipe(Effect.mapError(formFailure("plannedPublicationAt")))
    const plannedPublicationAt = plannedText === null
      ? null
      : yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(plannedText).pipe(Effect.mapError(formFailure("plannedPublicationAt")))
    const client = yield* WebClient
    const document = { heading, summary, priority, channel: args.channel, plannedPublicationAt }
    const created = args.selectedId === null
    const saved = yield* (created ? client["documents.create"](document) : client["documents.update"]({ id: args.selectedId, ...document }))
    return Message.SucceededSave({ document: saved, created, request: args.request })
  }).pipe(Effect.catch((error) => Effect.succeed(failed(args.request, error)))),
})
export const RemoveDocument = Command.define("RemoveDocument", {
  args: { id: Schema.String, request: RequestTokenSchema }, messages: [Message.SucceededRemove, Message.Failed],
  execute: ({ id, request }) => Effect.gen(function*() { const client = yield* WebClient; yield* client["documents.remove"]({ id }); return Message.SucceededRemove({ id, request }) }).pipe(Effect.catch((error) => Effect.succeed(failed(request, error)))),
})
const list = (request: RequestToken, cursor: string | null, append: boolean) => ListDocuments({ request, cursor, append })
const beginList = (model: Model, cursor: string | null, append: boolean) => { const started = Requests.start(model.requests, "documents.list"); return { state: started.state, command: list(started.request, cursor, append) } }
const emptyForm = { heading: "", summary: "", priority: "0", channel: "website" as const, plannedPublicationAt: "", selectedId: null as string | null }

export const update = (model: Model, message: Message) => Message.match<UpdateReturn>(message, {
  ChangedHeading: ({ value }) => ({ model: evo(model, { heading: () => value }) }), ChangedSummary: ({ value }) => ({ model: evo(model, { summary: () => value }) }), ChangedPriority: ({ value }) => ({ model: evo(model, { priority: () => value }) }), ChangedChannel: ({ value }) => ({ model: evo(model, { channel: () => value as Model["channel"] }) }), ChangedPlannedPublicationAt: ({ value }) => ({ model: evo(model, { plannedPublicationAt: () => value }) }),
  ClickedReload: () => { const listing = beginList(model, null, false); return { model: evo(model, { documents: () => [], nextCursor: () => null, requests: () => listing.state, notice: () => null }), commands: [listing.command] } },
  ClickedNext: () => { if (model.nextCursor === null || Requests.pending(model.requests, "documents.list")) return { model }; const listing = beginList(model, model.nextCursor, true); return { model: evo(model, { requests: () => listing.state }), commands: [listing.command] } },
  ClickedSave: () => { const started = Requests.start(model.requests, "documents.save"); return { model: evo(model, { requests: () => started.state, fieldErrors: () => ({}), notice: () => null }), commands: [SaveDocument({ selectedId: model.selectedId, heading: model.heading, summary: model.summary, priority: model.priority, channel: model.channel, plannedPublicationAt: model.plannedPublicationAt, request: started.request })] } },
  ClickedNew: () => ({ model: evo(model, { heading: () => "", summary: () => "", priority: () => "0", channel: () => "website", plannedPublicationAt: () => "", selectedId: () => null, fieldErrors: () => ({}), notice: () => null }) }),
  ClickedSelect: ({ id }) => Option.match(Array.findFirst(model.documents, (item) => item.id === id), { onNone: () => ({ model }), onSome: (document) => ({ model: evo(model, { selectedId: () => document.id, heading: () => document.heading, summary: () => document.summary ?? "", priority: () => String(document.priority), channel: () => document.channel, plannedPublicationAt: () => iso(document.plannedPublicationAt), fieldErrors: () => ({}), notice: () => null }) }) }),
  ClickedRemove: ({ id }) => { const started = Requests.start(model.requests, "documents.remove"); return { model: evo(model, { requests: () => started.state, notice: () => null }), commands: [RemoveDocument({ id, request: started.request })] } },
  SucceededList: ({ page, append, request }) => { if (!Requests.accepts(model.requests, request)) return { model }; const received = Page.receive({ items: model.documents, nextCursor: model.nextCursor }, page, append); return { model: evo(model, { documents: () => received.items, nextCursor: () => received.nextCursor, requests: () => Requests.succeed(model.requests, request) }) } },
  SucceededSave: ({ document, created, request }) => { if (!Requests.accepts(model.requests, request)) return { model }; const listing = beginList(evo(model, { requests: () => Requests.succeed(model.requests, request) }), null, false); return { model: evo(model, { selectedId: () => document.id, heading: () => document.heading, summary: () => document.summary ?? "", priority: () => String(document.priority), channel: () => document.channel, plannedPublicationAt: () => iso(document.plannedPublicationAt), documents: () => [], nextCursor: () => null, requests: () => listing.state, notice: () => ({ kind: "success" as const, text: created ? "Editorial plan added." : "Updated." }) }), commands: [listing.command] } },
  SucceededRemove: ({ id, request }) => { if (!Requests.accepts(model.requests, request)) return { model }; const base = evo(model, { requests: () => Requests.succeed(model.requests, request) }); const listing = beginList(base, null, false); const selected = model.selectedId === id; return { model: evo(model, { heading: () => selected ? "" : model.heading, summary: () => selected ? "" : model.summary, priority: () => selected ? "0" : model.priority, channel: () => selected ? "website" : model.channel, plannedPublicationAt: () => selected ? "" : model.plannedPublicationAt, selectedId: () => selected ? null : model.selectedId, documents: () => [], nextCursor: () => null, requests: () => listing.state, notice: () => ({ kind: "success" as const, text: "Removed." }) }), commands: [listing.command] } },
  Failed: ({ request, error, field }) => !Requests.accepts(model.requests, request) ? { model } : ({ model: evo(model, { requests: () => Requests.fail(model.requests, request, error), fieldErrors: () => field === null ? model.fieldErrors : { ...model.fieldErrors, [field]: error }, notice: () => ({ kind: "error" as const, text: error }) }) }),
})
export const init: Runtime.ApplicationInit<Model, Message, void, WebClient> = () => { const model: Model = { documents: [], nextCursor: null, ...emptyForm, requests: Requests.empty(), fieldErrors: {}, notice: null }; const listing = beginList(model, null, false); return { model: evo(model, { requests: () => listing.state }), commands: [listing.command] } }

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({ title: "Editorial calendar", body: shell(h, { title: "Editorial calendar", lede: "Plan articles across your website, newsletter, and print publication. This page uses the same public RPC as the CLI.", notice: model.notice, session: null, children: [h.div([h.Class("split")], [
  h.section([h.Class("panel stack")], [h.div([h.Class("actions")], [primaryButton(h, { label: Requests.pending(model.requests, "documents.list") ? "Loading…" : "Reload", message: Option.some(Message.ClickedReload()), type: "button", disabled: Requests.pending(model.requests, "documents.list") })]), dataTable(h, { caption: "Planned articles", columns: ["Heading", "Priority", "Channel", "Publication", ""], rows: model.documents, key: (document) => document.id, cells: (document) => [document.heading, String(document.priority), document.channel, iso(document.plannedPublicationAt) || "—", h.div([h.Class("row-actions")], [quietButton(h, { label: "Edit", message: Message.ClickedSelect({ id: document.id }), disabled: false }), quietButton(h, { label: "Remove", message: Message.ClickedRemove({ id: document.id }), disabled: Requests.pending(model.requests, "documents.remove") })])] }), model.nextCursor === null ? h.p([], ["All article pages loaded."]) : quietButton(h, { label: "Load more articles", message: Message.ClickedNext(), disabled: Requests.pending(model.requests, "documents.list") })]),
  h.section([h.Class("panel")], [h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSave())], [h.h2([], [model.selectedId === null ? "Add an article" : "Edit article"]), field(h, { id: "heading", label: "Heading", children: withError(h, textInput(h, { id: "heading", value: model.heading, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedHeading({ value }) }), model.fieldErrors.heading) }), field(h, { id: "summary", label: "Summary", children: withError(h, textareaInput(h, { id: "summary", value: model.summary, rows: 4, onInput: (value) => Message.ChangedSummary({ value }) }), model.fieldErrors.summary) }), field(h, { id: "priority", label: "Priority", children: withError(h, textInput(h, { id: "priority", value: model.priority, type: "number", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedPriority({ value }) }), model.fieldErrors.priority) }), field(h, { id: "channel", label: "Channel", children: selectInput(h, { id: "channel", value: model.channel, onChange: (value) => Message.ChangedChannel({ value }), choices: channelChoices }) }), field(h, { id: "planned-publication-at", label: "Planned publication (ISO datetime)", children: withError(h, textInput(h, { id: "planned-publication-at", value: model.plannedPublicationAt, type: "text", placeholder: "2026-10-01T09:00:00.000Z", autocomplete: "off", onInput: (value) => Message.ChangedPlannedPublicationAt({ value }) }), model.fieldErrors.plannedPublicationAt) }), h.div([h.Class("actions")], [primaryButton(h, { label: model.selectedId === null ? "Add article" : "Save changes", message: Option.none(), type: "submit", disabled: Requests.pending(model.requests, "documents.save") }), quietButton(h, { label: "Clear", message: Message.ClickedNew(), disabled: false })]) ])]),
]) ] }) })
