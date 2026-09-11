import { Effect, Option, Schema, pipe } from "effect"
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
} from "@effect-domains/example-web/html"
import { rpcCall } from "@effect-domains/example-web/rpc"
const GuideViewSchema = Schema.Struct({
  id: Schema.String,
  tenantId: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  body: Schema.String,
})

const GuidePageSchema = Schema.Struct({
  items: Schema.Array(GuideViewSchema),
  nextCursor: Schema.Unknown,
})

const guideChoices = [
  { value: "guide-sql-basics", label: "SQL field guide" },
  { value: "guide-audit-trails", label: "Audit trail guide (locked)" },
  { value: "guide-other-tenant", label: "Other tenant guide (hidden)" },
]

export const Model = Schema.Struct({
  token: Schema.String,
  selectedGuideId: Schema.String,
  guide: Schema.NullOr(GuideViewSchema),
  guides: Schema.Array(GuideViewSchema),
  detailBusy: Schema.Boolean,
  listBusy: Schema.Boolean,
  guideError: Schema.NullOr(Schema.String),
  listError: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedToken: { value: Schema.String },
  SelectedDemo: { token: Schema.String },
  SelectedGuide: { id: Schema.String },
  ClickedLoad: {},
  ClickedList: {},
  SucceededGuide: { guide: GuideViewSchema, token: Schema.String },
  SucceededList: { guides: Schema.Array(GuideViewSchema), token: Schema.String },
  FailedGuide: { error: Schema.String, token: Schema.String },
  FailedList: { error: Schema.String, token: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message>

const resetSession = (model: Model, token: string) => evo(model, {
  token: () => token,
  guide: () => null,
  guides: () => [],
  detailBusy: () => false,
  listBusy: () => false,
  guideError: () => null,
  listError: () => null,
})

export const GetGuide = Command.define("GetGuide", {
  args: { id: Schema.String, token: Schema.String },
  messages: [Message.SucceededGuide, Message.FailedGuide],
  execute: ({ id, token }) => pipe(
    rpcCall({
      tag: "guides.get",
      payload: { id },
      token,
      success: GuideViewSchema,
    }),
    Effect.match({
      onSuccess: (guide) => Message.SucceededGuide({ guide, token }),
      onFailure: (error) => Message.FailedGuide({ error: error.message, token }),
    }),
  ),
})

export const ListGuides = Command.define("ListGuides", {
  args: { token: Schema.String },
  messages: [Message.SucceededList, Message.FailedList],
  execute: ({ token }) => pipe(
    rpcCall({
      tag: "guides.list",
      payload: {},
      token,
      success: GuidePageSchema,
    }),
    Effect.match({
      onSuccess: (page) => Message.SucceededList({ guides: page.items, token }),
      onFailure: (error) => Message.FailedList({ error: error.message, token }),
    }),
  ),
})

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedToken: ({ value }) => ({ model: value === model.token ? model : resetSession(model, value) }),
    SelectedDemo: ({ token }) => ({ model: token === model.token ? model : resetSession(model, token) }),
    SelectedGuide: ({ id }) => ({
      model: evo(model, { selectedGuideId: () => id, guide: () => null, guideError: () => null }),
    }),
    ClickedLoad: () => ({
      model: evo(model, { detailBusy: () => true, guide: () => null, guideError: () => null }),
      commands: [GetGuide({ id: model.selectedGuideId, token: model.token })],
    }),
    ClickedList: () => ({
      model: evo(model, { listBusy: () => true, listError: () => null }),
      commands: [ListGuides({ token: model.token })],
    }),
    SucceededGuide: ({ guide, token }) => token !== model.token
      ? { model }
      : { model: evo(model, { guide: () => guide, detailBusy: () => false }) },
    SucceededList: ({ guides, token }) => token !== model.token
      ? { model }
      : { model: evo(model, { guides: () => guides, listBusy: () => false }) },
    FailedGuide: ({ error, token }) => token !== model.token
      ? { model }
      : { model: evo(model, { detailBusy: () => false, guideError: () => error }) },
    FailedList: ({ error, token }) => token !== model.token
      ? { model }
      : { model: evo(model, { listBusy: () => false, listError: () => error }) },
  })

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    token: "bob-demo",
    selectedGuideId: "guide-sql-basics",
    guide: null,
    guides: [],
    detailBusy: true,
    listBusy: true,
    guideError: null,
    listError: null,
  },
  commands: [
    GetGuide({ id: "guide-sql-basics", token: "bob-demo" }),
    ListGuides({ token: "bob-demo" }),
  ],
})

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Purchased guides",
  body: shell(h, {
    title: "Purchased guides",
    lede: "Read guides granted to this account. The same entitlement checks apply to every RPC request.",
    notice: model.listError === null
      ? model.guideError === null ? null : { kind: "error", text: model.guideError }
      : { kind: "error", text: `Guide list failed: ${model.listError}` },
    session: {
      token: model.token,
      onInput: (value) => Message.ChangedToken({ value }),
      onSelect: (token) => Message.SelectedDemo({ token }),
    },
    children: [
      h.div(
        [h.Class("split")],
        [
          h.section(
            [h.Class("panel stack")],
            [
              h.h2([], ["Open a guide"]),
              field(h, {
                id: "guide-id",
                label: "Guide",
                children: selectInput(h, {
                  id: "guide-id",
                  value: model.selectedGuideId,
                  choices: guideChoices,
                  onChange: (id) => Message.SelectedGuide({ id }),
                }),
              }),
              h.div(
                [h.Class("actions")],
                [
                  primaryButton(h, {
                    label: model.detailBusy ? "Loading…" : "Load guide",
                    message: Option.some(Message.ClickedLoad()),
                    type: "button",
                    disabled: model.detailBusy,
                  }),
                  quietButton(h, {
                    label: model.listBusy ? "Listing…" : "List guides",
                    message: Message.ClickedList(),
                    disabled: model.listBusy,
                  }),
                ],
              ),
              model.guideError === null
                ? h.empty
                : h.p([h.Class("notice notice-error"), h.Role("status")], [`Guide unavailable: ${model.guideError}`]),
              model.guide === null
                ? h.p([h.Class("empty")], [model.detailBusy ? "Loading guide…" : "Choose a guide to read."])
                : h.div(
                  [h.Class("stack")],
                  [
                    h.h3([], [model.guide.title]),
                    h.p([], [model.guide.summary]),
                    h.p([], [model.guide.body]),
                  ],
                ),
            ],
          ),
          h.section(
            [h.Class("panel stack")],
            [
              h.h2([], ["Available guides"]),
              h.p([], ["Listing is all-or-nothing: a visible guide without a purchase grant returns an error."]),
              dataTable(h, {
                caption: "Guides returned by guides.list",
                columns: ["Title", "Summary"],
                rows: model.guides,
                key: (guide) => guide.id,
                cells: (guide) => [guide.title, guide.summary],
              }),
            ],
          ),
        ],
      ),
    ],
  }),
})
