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
  shell,
  textInput,
  textareaInput,
} from "@effect-domains/example-web/html"
import { rpcCall } from "@effect-domains/example-web/rpc"
import { FieldReportSchema } from "../domain.ts"

const ReportRowSchema = Schema.Struct({
  id: Schema.String,
  title: FieldReportSchema.fields.title,
  site: FieldReportSchema.fields.site,
  body: FieldReportSchema.fields.body,
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

const ReportPageSchema = Schema.Struct({
  items: Schema.Array(ReportRowSchema),
  nextCursor: Schema.Unknown,
})

const hexByte = (byte: number) => byte.toString(16).padStart(2, "0")

const newReportId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const hex = Array.join(Array.map([
    bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!,
    bytes[6]!, bytes[7]!, bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!,
  ], hexByte), "")
  return `report_${hex}`
}

export const Model = Schema.Struct({
  reports: Schema.Array(ReportRowSchema),
  nextCursor: Schema.NullOr(Schema.String),
  token: Schema.String,
  filterSite: Schema.String,
  id: Schema.String,
  title: Schema.String,
  site: Schema.String,
  body: Schema.String,
  selectedId: Schema.NullOr(Schema.String),
  busy: Schema.Boolean,
  notice: Schema.NullOr(Schema.Struct({
    kind: Schema.Literals(["info", "error", "success"]),
    text: Schema.String,
  })),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedToken: { value: Schema.String },
  SelectedToken: { token: Schema.String },
  ChangedFilterSite: { value: Schema.String },
  ChangedId: { value: Schema.String },
  ChangedTitle: { value: Schema.String },
  ChangedSite: { value: Schema.String },
  ChangedBody: { value: Schema.String },
  ClickedReload: {},
  ClickedSave: {},
  ClickedNew: {},
  ClickedSelect: { id: Schema.String },
  ClickedRemove: { id: Schema.String },
  SucceededList: { items: Schema.Array(ReportRowSchema), nextCursor: Schema.NullOr(Schema.String) },
  SucceededGet: { report: ReportRowSchema },
  SucceededSave: { report: ReportRowSchema, created: Schema.Boolean },
  SucceededRemove: { id: Schema.String },
  Failed: { error: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message>

const emptyForm = () => ({
  id: newReportId(),
  title: "",
  site: "",
  body: "",
  selectedId: null as string | null,
})

export const ListReports = Command.define("ListReports", {
  args: { filterSite: Schema.String, token: Schema.String },
  messages: [Message.SucceededList, Message.Failed],
  execute: ({ filterSite, token }) =>
    pipe(
      rpcCall({
        tag: "reports.list",
        payload: {
          filter: filterSite.trim() === "" ? {} : { site: filterSite.trim() },
          limit: 25,
        },
        token,
        success: ReportPageSchema,
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

export const GetReport = Command.define("GetReport", {
  args: { id: Schema.String, token: Schema.String },
  messages: [Message.SucceededGet, Message.Failed],
  execute: ({ id, token }) =>
    pipe(
      rpcCall({
        tag: "reports.get",
        payload: { id },
        token,
        success: ReportRowSchema,
      }),
      Effect.match({
        onSuccess: (report) => Message.SucceededGet({ report }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const SaveReport = Command.define("SaveReport", {
  args: {
    selectedId: Schema.NullOr(Schema.String),
    id: Schema.String,
    title: Schema.String,
    site: Schema.String,
    body: Schema.String,
    token: Schema.String,
  },
  messages: [Message.SucceededSave, Message.Failed],
  execute: (args) => {
    const report = {
      id: args.selectedId ?? args.id.trim(),
      title: args.title.trim(),
      site: args.site.trim(),
      body: args.body.trim(),
    }
    const creating = args.selectedId === null
    return pipe(
      rpcCall({
        tag: creating ? "reports.create" : "reports.update",
        payload: report,
        token: args.token,
        success: ReportRowSchema,
      }),
      Effect.match({
        onSuccess: (saved) => Message.SucceededSave({ report: saved, created: creating }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    )
  },
})

export const RemoveReport = Command.define("RemoveReport", {
  args: { id: Schema.String, token: Schema.String },
  messages: [Message.SucceededRemove, Message.Failed],
  execute: ({ id, token }) =>
    pipe(
      rpcCall({
        tag: "reports.remove",
        payload: { id },
        token,
        success: Schema.Null,
      }),
      Effect.match({
        onSuccess: () => Message.SucceededRemove({ id }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

const reload = (model: Model) => ListReports({
  filterSite: model.filterSite,
  token: model.token,
})

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedToken: ({ value }) => ({ model: evo(model, { token: () => value }) }),
    SelectedToken: ({ token }) => {
      const next = evo(model, { token: () => token, busy: () => true, notice: () => null })
      return { model: next, commands: [reload(next)] }
    },
    ChangedFilterSite: ({ value }) => {
      const next = evo(model, { filterSite: () => value, busy: () => true })
      return { model: next, commands: [reload(next)] }
    },
    ChangedId: ({ value }) => ({ model: evo(model, { id: () => value }) }),
    ChangedTitle: ({ value }) => ({ model: evo(model, { title: () => value }) }),
    ChangedSite: ({ value }) => ({ model: evo(model, { site: () => value }) }),
    ChangedBody: ({ value }) => ({ model: evo(model, { body: () => value }) }),
    ClickedReload: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [reload(model)],
    }),
    ClickedSave: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [SaveReport({
        selectedId: model.selectedId,
        id: model.id,
        title: model.title,
        site: model.site,
        body: model.body,
        token: model.token,
      })],
    }),
    ClickedNew: () => {
      const form = emptyForm()
      return {
        model: evo(model, {
          id: () => form.id,
          title: () => form.title,
          site: () => form.site,
          body: () => form.body,
          selectedId: () => form.selectedId,
          notice: () => null,
        }),
      }
    },
    ClickedSelect: ({ id }) => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [GetReport({ id, token: model.token })],
    }),
    ClickedRemove: ({ id }) => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [RemoveReport({ id, token: model.token })],
    }),
    SucceededList: ({ items, nextCursor }) => ({
      model: evo(model, { reports: () => items, nextCursor: () => nextCursor, busy: () => false }),
    }),
    SucceededGet: ({ report }) => ({
      model: evo(model, {
        id: () => report.id,
        title: () => report.title,
        site: () => report.site,
        body: () => report.body,
        selectedId: () => report.id,
        busy: () => false,
      }),
    }),
    SucceededSave: ({ report, created }) => {
      const next = evo(model, {
        id: () => report.id,
        title: () => report.title,
        site: () => report.site,
        body: () => report.body,
        selectedId: () => report.id,
        busy: () => true,
        notice: () => ({ kind: "success" as const, text: created ? "Report filed." : "Report updated." }),
      })
      return { model: next, commands: [reload(next)] }
    },
    SucceededRemove: ({ id }) => {
      const form = model.selectedId === id ? emptyForm() : undefined
      const next = evo(model, {
        id: () => form?.id ?? model.id,
        title: () => form?.title ?? model.title,
        site: () => form?.site ?? model.site,
        body: () => form?.body ?? model.body,
        selectedId: () => form?.selectedId ?? model.selectedId,
        busy: () => true,
        notice: () => ({ kind: "success" as const, text: "Report removed." }),
      })
      return { model: next, commands: [reload(next)] }
    },
    Failed: ({ error }) => ({
      model: evo(model, {
        busy: () => false,
        notice: () => ({ kind: "error" as const, text: error }),
      }),
    }),
  })

export const init: Runtime.ApplicationInit<Model, Message> = () => {
  const form = emptyForm()
  return {
    model: {
      reports: [],
      nextCursor: null,
      token: "alice-demo",
      filterSite: "",
      ...form,
      busy: true,
      notice: null,
    },
    commands: [ListReports({ filterSite: "", token: "alice-demo" })],
  }
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Field notes",
  body: shell(h, {
    title: "Field notes",
    lede: "Record and share field reports. Readers can inspect reports, editors can file and update them, and administrators can remove them.",
    notice: model.notice,
    session: {
      token: model.token,
      onInput: (value) => Message.ChangedToken({ value }),
      onSelect: (token) => Message.SelectedToken({ token }),
    },
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
                    id: "filter-site",
                    label: "Site",
                    children: textInput(h, {
                      id: "filter-site",
                      value: model.filterSite,
                      type: "text",
                      placeholder: "All sites",
                      autocomplete: "off",
                      onInput: (value) => Message.ChangedFilterSite({ value }),
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
                caption: "Reports",
                columns: ["Title", "Site", "Identifier", ""],
                rows: model.reports,
                key: (report) => report.id,
                cells: (report) => [
                  report.title,
                  report.site,
                  report.id,
                  h.div(
                    [h.Class("row-actions")],
                    [
                      quietButton(h, { label: "Open", message: Message.ClickedSelect({ id: report.id }), disabled: false }),
                      quietButton(h, {
                        label: "Remove",
                        message: Message.ClickedRemove({ id: report.id }),
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
                  h.h2([], [model.selectedId === null ? "File a report" : "Edit report"]),
                  field(h, {
                    id: "report-id",
                    label: "Identifier",
                    children: textInput(h, {
                      id: "report-id",
                      value: model.id,
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                      onInput: (value) => Message.ChangedId({ value }),
                    }),
                  }),
                  field(h, {
                    id: "report-title",
                    label: "Title",
                    children: textInput(h, {
                      id: "report-title",
                      value: model.title,
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                      onInput: (value) => Message.ChangedTitle({ value }),
                    }),
                  }),
                  field(h, {
                    id: "report-site",
                    label: "Site",
                    children: textInput(h, {
                      id: "report-site",
                      value: model.site,
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                      onInput: (value) => Message.ChangedSite({ value }),
                    }),
                  }),
                  field(h, {
                    id: "report-body",
                    label: "Report",
                    children: textareaInput(h, {
                      id: "report-body",
                      value: model.body,
                      rows: 7,
                      onInput: (value) => Message.ChangedBody({ value }),
                    }),
                  }),
                  h.div(
                    [h.Class("actions")],
                    [
                      primaryButton(h, {
                        label: model.selectedId === null ? "File report" : "Save changes",
                        message: Option.none(),
                        type: "submit",
                        disabled: model.busy,
                      }),
                      quietButton(h, { label: "New report", message: Message.ClickedNew(), disabled: false }),
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
