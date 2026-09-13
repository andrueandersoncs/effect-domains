import { Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import { dataTable, field, primaryButton, quietButton, shell, textInput, textareaInput } from "@effect-domains/example-web/html"
import { BrowserModel } from "effect-domains/browser-model"
import { Page } from "effect-domains/page"
import { ResourcePager } from "effect-domains/resource-pager"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { Requests, RequestStateSchema, RequestTokenSchema } from "effect-domains/requests"
import { identitySessionView } from "@effect-domains/example-web/session"
import { IdentitySession as Session } from "effect-domains/identity-session"

import { IdentityRpcs } from "effect-domains/identity-rpc"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { FieldReportSchema } from "../domain.ts"
import { FieldReportsResource } from "../resources.ts"

type SessionClient = Type<typeof Session.Client>

const FieldNotesRpcs = IdentityRpcs.merge(FieldReportsResource.group)
const ReportSchema = Schema.toType(FieldReportsResource.table.rowSchema)
const ReportPageSchema = FieldReportsResource.contracts.list.successSchema
type Report = typeof ReportSchema.Type

export const WebClient = RpcService.make({ name: "field-notes/WebClient", group: FieldNotesRpcs })
export type WebClient = Type<typeof WebClient>

export const Model = Schema.Struct({
  session: Session.ModelSchema,
  requests: RequestStateSchema,
  reports: ReportPageSchema,
  filterSite: Schema.String,
  id: Schema.String,
  title: Schema.String,
  site: Schema.String,
  body: Schema.String,
  selectedId: Schema.NullOr(Schema.String),
  notice: BrowserModel.NoticeSchema,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  SessionChanged: { message: Session.MessageSchema },
  ChangedFilterSite: { value: Schema.String },
  ChangedId: { value: Schema.String },
  ChangedTitle: { value: Schema.String },
  ChangedSite: { value: Schema.String },
  ChangedBody: { value: Schema.String },
  ClickedReload: {},
  ClickedMore: {},
  ClickedSave: {},
  ClickedNew: {},
  ClickedSelect: { id: Schema.String },
  ClickedRemove: { id: Schema.String },
  SucceededList: { request: RequestTokenSchema, append: Schema.Boolean, page: ReportPageSchema },
  SucceededGet: { request: RequestTokenSchema, report: ReportSchema },
  SucceededSave: { request: RequestTokenSchema, report: ReportSchema, created: Schema.Boolean },
  SucceededRemove: { request: RequestTokenSchema, id: Schema.String },
  Failed: { request: RequestTokenSchema, error: Schema.String },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient | SessionClient>

const newReportId = () => `report_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
const emptyForm = () => ({ id: newReportId(), title: "", site: "", body: "", selectedId: null as string | null })

export const ListReports = Command.define("ListReports", {
  args: { request: RequestTokenSchema, token: Schema.String, filterSite: Schema.String, cursor: Schema.NullOr(Schema.String), append: Schema.Boolean },
  messages: [Message.SucceededList, Message.Failed],
  execute: ({ request, token, filterSite, cursor, append }) => pipe(
    Effect.gen(function*() {
      const client = yield* WebClient
      return yield* client["reports.list"]({
        filter: filterSite.trim() === "" ? {} : { site: filterSite.trim() },
        limit: 50,
        ...Page.input(cursor),
      }, RpcBrowser.requestOptions(token))
    }),
    Effect.match({
      onSuccess: (page) => Message.SucceededList({ request, append, page }),
      onFailure: (error) => Message.Failed({ request, error: RpcBrowser.messageFromUnknown(error) }),
    }),
  ),
})

export const GetReport = Command.define("GetReport", {
  args: { request: RequestTokenSchema, token: Schema.String, id: Schema.String },
  messages: [Message.SucceededGet, Message.Failed],
  execute: ({ request, token, id }) => pipe(
    Effect.gen(function*() {
      const client = yield* WebClient
      return yield* client["reports.get"]({ id }, RpcBrowser.requestOptions(token))
    }),
    Effect.match({
      onSuccess: (report) => Message.SucceededGet({ request, report }),
      onFailure: (error) => Message.Failed({ request, error: RpcBrowser.messageFromUnknown(error) }),
    }),
  ),
})

export const SaveReport = Command.define("SaveReport", {
  args: { request: RequestTokenSchema, token: Schema.String, selectedId: Schema.NullOr(Schema.String), report: Schema.toEncoded(FieldReportSchema) },
  messages: [Message.SucceededSave, Message.Failed],
  execute: ({ request, token, selectedId, report }) => pipe(
    Effect.gen(function*() {
      const client = yield* WebClient
      const decoded = yield* Schema.decodeUnknownEffect(FieldReportSchema)(report)
      return selectedId === null
        ? yield* client["reports.create"](decoded, RpcBrowser.requestOptions(token))
        : yield* client["reports.update"](decoded, RpcBrowser.requestOptions(token))
    }),
    Effect.match({
      onSuccess: (report) => Message.SucceededSave({ request, report, created: selectedId === null }),
      onFailure: (error) => Message.Failed({ request, error: RpcBrowser.messageFromUnknown(error) }),
    }),
  ),
})

export const RemoveReport = Command.define("RemoveReport", {
  args: { request: RequestTokenSchema, token: Schema.String, id: Schema.String },
  messages: [Message.SucceededRemove, Message.Failed],
  execute: ({ request, token, id }) => pipe(
    Effect.gen(function*() {
      const client = yield* WebClient
      yield* client["reports.remove"]({ id }, RpcBrowser.requestOptions(token))
    }),
    Effect.match({
      onSuccess: () => Message.SucceededRemove({ request, id }),
      onFailure: (error) => Message.Failed({ request, error: RpcBrowser.messageFromUnknown(error) }),
    }),
  ),
})

const ReportsPager = ResourcePager.make("reports.list")
const list = (model: Model, append: boolean) => {
  const token = Session.token(model.session)
  if (token === null) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Sign in before listing reports." }) }), commands: [] }
  const started = pipe(ReportsPager.begin(model.requests, model.reports, append), Option.getOrThrow)
  return {
    model: evo(model, { requests: () => started.requests, reports: () => started.page, notice: () => null }),
    commands: [ListReports({ request: started.request, token, filterSite: model.filterSite, cursor: started.cursor, append: started.append })],
  }
}
const clearIdentity = (model: Model, session: typeof Session.ModelSchema.Type): Model => {
  const reset = ReportsPager.reset({ page: model.reports, requests: model.requests })
  return {
    ...model,
    ...emptyForm(),
    session,
    requests: reset.requests,
    reports: reset.page,
    filterSite: "",
    notice: null,
  }
}
const setReport = (model: Model, report: Report) => evo(model, {
  id: () => report.id, title: () => report.title, site: () => report.site, body: () => report.body, selectedId: () => report.id,
})

export const update = (model: Model, message: Message): UpdateReturn => Message.match<UpdateReturn>(message, {
  SessionChanged: ({ message }) => {
    const child = Session.embed(model.session, message, (message) => Message.SessionChanged({ message }))
    const changed = Session.generationChanged(model.session, child.model)
    const next = changed ? clearIdentity(model, child.model) : evo(model, { session: () => child.model })
    if (!changed || child.model.token === null) return { model: next, commands: child.commands }
    const listing = list(next, false)
    return { model: listing.model, commands: [...child.commands, ...listing.commands] }
  },
  ChangedFilterSite: ({ value }) => list(evo(model, { filterSite: () => value }), false),
  ChangedId: ({ value }) => ({ model: evo(model, { id: () => value }) }),
  ChangedTitle: ({ value }) => ({ model: evo(model, { title: () => value }) }),
  ChangedSite: ({ value }) => ({ model: evo(model, { site: () => value }) }),
  ChangedBody: ({ value }) => ({ model: evo(model, { body: () => value }) }),
  ClickedReload: () => list(model, false),
  ClickedMore: () => model.reports.nextCursor === null || ReportsPager.pending(model.requests) ? { model } : list(model, true),
  ClickedNew: () => ({ model: { ...model, ...emptyForm(), requests: Requests.invalidate(Requests.invalidate(model.requests, "reports.get"), "reports.save"), notice: null } }),
  ClickedSelect: ({ id }) => {
    const token = Session.token(model.session)
    if (token === null) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Sign in before opening a report." }) }) }
    const started = Requests.start(Requests.invalidate(model.requests, "reports.save"), "reports.get")
    return { model: evo(model, { requests: () => started.state, notice: () => null }), commands: [GetReport({ request: started.request, token, id })] }
  },
  ClickedSave: () => {
    const token = Session.token(model.session)
    if (token === null) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Sign in before saving a report." }) }) }
    if (model.id.trim() === "" || model.title.trim() === "" || model.site.trim() === "" || model.body.trim() === "") {
      return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Identifier, title, site, and report are required." }) }) }
    }
    const started = Requests.start(model.requests, "reports.save")
    const report = { id: model.id.trim(), title: model.title.trim(), site: model.site.trim(), body: model.body.trim() }
    return { model: evo(model, { requests: () => started.state, notice: () => null }), commands: [SaveReport({ request: started.request, token, selectedId: model.selectedId, report })] }
  },
  ClickedRemove: ({ id }) => {
    const token = Session.token(model.session)
    if (token === null) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Sign in before removing a report." }) }) }
    const started = Requests.start(model.requests, "reports.remove")
    return { model: evo(model, { requests: () => started.state, notice: () => null }), commands: [RemoveReport({ request: started.request, token, id })] }
  },
  SucceededList: ({ request, append, page }) => Option.match(
    ReportsPager.receive({ page: model.reports, requests: model.requests }, request, page, append),
    {
      onNone: () => ({ model }),
      onSome: (received) => ({ model: evo(model, { requests: () => received.requests, reports: () => received.page }) }),
    },
  ),
  SucceededGet: ({ request, report }) => !Requests.accepts(model.requests, request) ? { model } : {
    model: setReport(evo(model, { requests: () => Requests.succeed(model.requests, request), notice: () => null }), report),
  },
  SucceededSave: ({ request, report, created }) => {
    if (!Requests.accepts(model.requests, request)) return { model }
    const next = setReport(evo(model, {
      requests: () => Requests.succeed(model.requests, request),
      notice: () => ({ kind: "success" as const, text: created ? "Report filed." : "Report updated." }),
    }), report)
    return list(next, false)
  },
  SucceededRemove: ({ request, id }) => {
    if (!Requests.accepts(model.requests, request)) return { model }
    const next = evo(model, {
      requests: () => Requests.succeed(model.requests, request),
      ...(model.selectedId === id ? Object.fromEntries(Object.entries(emptyForm()).map(([key, value]) => [key, () => value])) : {}),
      notice: () => ({ kind: "success" as const, text: "Report removed." }),
    })
    return list(next, false)
  },
  Failed: ({ request, error }) => !Requests.accepts(model.requests, request) ? { model } : {
    model: evo(model, { requests: () => Requests.fail(model.requests, request, error), notice: () => ({ kind: "error" as const, text: error }) }),
  },
})

export const init: Runtime.ApplicationInit<Model, Message, void, WebClient | SessionClient> = () => ({
  model: { session: Session.empty(), requests: Requests.empty(), reports: Page.empty<Report>(), filterSite: "", ...emptyForm(), notice: null },
})

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Field notes",
  body: shell(h, {
    title: "Field notes",
    lede: "Record and share field reports. Readers can inspect reports, editors can file and update them, and administrators can remove them.",
    notice: model.notice,
    session: identitySessionView(h, model.session, (message) => Message.SessionChanged({ message })),
    children: [h.div([h.Class("split")], [
      h.section([h.Class("panel stack")], [
        h.div([h.Class("actions")], [
          field(h, { id: "filter-site", label: "Site", children: textInput(h, { id: "filter-site", value: model.filterSite, type: "text", placeholder: "All sites", autocomplete: "off", onInput: (value) => Message.ChangedFilterSite({ value }) }) }),
          primaryButton(h, { label: Requests.pending(model.requests, "reports.list") ? "Loading…" : "Reload", message: Option.some(Message.ClickedReload()), type: "button", disabled: Requests.pending(model.requests, "reports.list") }),
        ]),
        dataTable(h, { caption: "Reports", columns: ["Title", "Site", "Identifier", ""], rows: model.reports.items, key: (report) => report.id, cells: (report) => [
          report.title, report.site, report.id,
          h.div([h.Class("row-actions")], [quietButton(h, { label: "Open", message: Message.ClickedSelect({ id: report.id }), disabled: false }), quietButton(h, { label: "Remove", message: Message.ClickedRemove({ id: report.id }), disabled: Requests.pending(model.requests) })]),
        ] }),
        model.reports.nextCursor === null ? h.empty : primaryButton(h, { label: "Load more", message: Option.some(Message.ClickedMore()), type: "button", disabled: Requests.pending(model.requests, "reports.list") }),
      ]),
      h.section([h.Class("panel")], [h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSave())], [
        h.h2([], [model.selectedId === null ? "File a report" : "Edit report"]),
        field(h, { id: "report-id", label: "Identifier", children: textInput(h, { id: "report-id", value: model.id, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedId({ value }) }) }),
        field(h, { id: "report-title", label: "Title", children: textInput(h, { id: "report-title", value: model.title, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedTitle({ value }) }) }),
        field(h, { id: "report-site", label: "Site", children: textInput(h, { id: "report-site", value: model.site, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedSite({ value }) }) }),
        field(h, { id: "report-body", label: "Report", children: textareaInput(h, { id: "report-body", value: model.body, rows: 7, onInput: (value) => Message.ChangedBody({ value }) }) }),
        h.div([h.Class("actions")], [primaryButton(h, { label: model.selectedId === null ? "File report" : "Save changes", message: Option.none(), type: "submit", disabled: Requests.pending(model.requests) }), quietButton(h, { label: "New report", message: Message.ClickedNew(), disabled: false })]),
      ])]),
    ])],
  }),
})
