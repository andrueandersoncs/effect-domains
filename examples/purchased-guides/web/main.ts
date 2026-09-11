import { Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import { dataTable, field, primaryButton, quietButton, selectInput, shell } from "@effect-domains/example-web/html"
import { Page } from "@effect-domains/example-web/page"
import { bearer, formatRpcError } from "@effect-domains/example-web/rpc"
import { Requests, RequestStateSchema, RequestTokenSchema } from "@effect-domains/example-web/requests"
import { Session, SessionClient, SessionMessage, SessionModel } from "@effect-domains/example-web/session"
import { EntitlementRequired } from "effect-domains/entitlements"
import { IdentityRpcs } from "effect-domains/identity-rpc"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { GuidesResource } from "../resources.ts"

const PurchasedGuidesRpcs = IdentityRpcs.merge(GuidesResource.group)
const GuideSchema = GuidesResource.table.rowSchema
const GuidePageSchema = Page.schema(GuideSchema)
type Guide = typeof GuideSchema.Type

export const WebClient = RpcService.make({ name: "purchased-guides/WebClient", group: PurchasedGuidesRpcs })
export type WebClient = Type<typeof WebClient>

const guideChoices = [
  { value: "guide-sql-basics", label: "SQL field guide" },
  { value: "guide-audit-trails", label: "Audit trail guide" },
]
const errorText = (error: unknown) => error instanceof EntitlementRequired || (
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "EntitlementRequired"
)
  ? "This guide requires an active purchase entitlement."
  : formatRpcError(error)

export const Model = Schema.Struct({
  session: SessionModel,
  requests: RequestStateSchema,
  selectedGuideId: Schema.String,
  guide: Schema.NullOr(GuideSchema),
  guides: GuidePageSchema,
  notice: Schema.NullOr(Schema.Struct({ kind: Schema.Literals(["info", "error", "success"]), text: Schema.String })),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  SessionChanged: { message: SessionMessage },
  SelectedGuide: { id: Schema.String },
  ClickedLoad: {},
  ClickedList: {},
  ClickedMore: {},
  SucceededGuide: { request: RequestTokenSchema, guide: GuideSchema },
  SucceededList: { request: RequestTokenSchema, append: Schema.Boolean, page: GuidePageSchema },
  Failed: { request: RequestTokenSchema, error: Schema.String },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient | SessionClient>

export const GetGuide = Command.define("GetGuide", {
  args: { request: RequestTokenSchema, token: Schema.String, id: Schema.String },
  messages: [Message.SucceededGuide, Message.Failed],
  execute: ({ request, token, id }) => pipe(
    Effect.gen(function*() {
      const client = yield* WebClient
      return yield* client["guides.get"]({ id }, bearer(token))
    }),
    Effect.match({
      onSuccess: (guide) => Message.SucceededGuide({ request, guide }),
      onFailure: (error) => Message.Failed({ request, error: errorText(error) }),
    }),
  ),
})

export const ListGuides = Command.define("ListGuides", {
  args: { request: RequestTokenSchema, token: Schema.String, cursor: Schema.NullOr(Schema.String), append: Schema.Boolean },
  messages: [Message.SucceededList, Message.Failed],
  execute: ({ request, token, cursor, append }) => pipe(
    Effect.gen(function*() {
      const client = yield* WebClient
      return yield* client["guides.list"]({ limit: 25, ...Page.input(cursor) }, bearer(token))
    }),
    Effect.match({
      onSuccess: (page) => Message.SucceededList({ request, append, page }),
      onFailure: (error) => Message.Failed({ request, error: errorText(error) }),
    }),
  ),
})

const list = (model: Model, cursor: string | null, append: boolean) => {
  const token = Session.token(model.session)
  if (token === null) return {
    model: evo(model, { notice: () => ({ kind: "error" as const, text: "Sign in before listing guides." }) }),
    commands: [],
  }
  const started = Requests.start(model.requests, "guides.list")
  return {
    model: evo(model, { requests: () => started.state, guides: () => append ? model.guides : Page.empty<Guide>(), notice: () => null }),
    commands: [ListGuides({ request: started.request, token, cursor, append })],
  }
}

export const update = (model: Model, message: Message): UpdateReturn => Message.match<UpdateReturn>(message, {
  SessionChanged: ({ message }) => {
    const child = Session.update(model.session, message)
    const changed = Session.generation(child.model) !== Session.generation(model.session)
    const next = changed
      ? evo(model, { session: () => child.model, requests: () => Requests.reset(model.requests), guide: () => null, guides: () => Page.empty<Guide>(), notice: () => null })
      : evo(model, { session: () => child.model })
    const commands = Command.mapMessages(child.commands ?? [], (message) => Message.SessionChanged({ message }))
    if (!changed || Session.token(next.session) === null) return { model: next, commands }
    const listing = list(next, null, false)
    return { model: listing.model, commands: [...commands, ...listing.commands] }
  },
  SelectedGuide: ({ id }) => ({ model: evo(model, { requests: () => Requests.invalidate(model.requests, "guides.get"), selectedGuideId: () => id, guide: () => null, notice: () => null }) }),
  ClickedLoad: () => {
    const token = Session.token(model.session)
    if (token === null) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Sign in before loading a guide." }) }) }
    const started = Requests.start(model.requests, "guides.get")
    return { model: evo(model, { requests: () => started.state, guide: () => null, notice: () => null }), commands: [GetGuide({ request: started.request, token, id: model.selectedGuideId })] }
  },
  ClickedList: () => list(model, null, false),
  ClickedMore: () => model.guides.nextCursor === null || Requests.pending(model.requests, "guides.list") ? { model } : list(model, model.guides.nextCursor, true),
  SucceededGuide: ({ request, guide }) => !Requests.accepts(model.requests, request) ? { model } : {
    model: evo(model, { requests: () => Requests.succeed(model.requests, request), guide: () => guide }),
  },
  SucceededList: ({ request, append, page }) => !Requests.accepts(model.requests, request) ? { model } : {
    model: evo(model, { requests: () => Requests.succeed(model.requests, request), guides: () => Page.receive(model.guides, page, append) }),
  },
  Failed: ({ request, error }) => !Requests.accepts(model.requests, request) ? { model } : {
    model: evo(model, { requests: () => Requests.fail(model.requests, request, error), notice: () => ({ kind: "error" as const, text: error }) }),
  },
})

export const init: Runtime.ApplicationInit<Model, Message, void, WebClient | SessionClient> = () => ({
  model: {
    session: Session.empty(),
    requests: Requests.empty(),
    selectedGuideId: "guide-sql-basics",
    guide: null,
    guides: Page.empty<Guide>(),
    notice: null,
  },
})

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Purchased guides",
  body: shell(h, {
    title: "Purchased guides",
    lede: "Read guides granted to this account. The same entitlement checks apply to every RPC request.",
    notice: model.notice,
    session: Session.view(h, model.session, (message) => Message.SessionChanged({ message })),
    children: [h.div([h.Class("split")], [
      h.section([h.Class("panel stack")], [
        h.h2([], ["Open a guide"]),
        field(h, { id: "guide-id", label: "Guide", children: selectInput(h, { id: "guide-id", value: model.selectedGuideId, choices: guideChoices, onChange: (id) => Message.SelectedGuide({ id }) }) }),
        h.div([h.Class("actions")], [
          primaryButton(h, { label: Requests.pending(model.requests, "guides.get") ? "Loading…" : "Load guide", message: Option.some(Message.ClickedLoad()), type: "button", disabled: Requests.pending(model.requests, "guides.get") }),
          quietButton(h, { label: Requests.pending(model.requests, "guides.list") ? "Listing…" : "List guides", message: Message.ClickedList(), disabled: Requests.pending(model.requests, "guides.list") }),
        ]),
        model.guide === null ? h.p([h.Class("empty")], ["Choose a guide to read."]) : h.div([h.Class("stack")], [h.h3([], [model.guide.title]), h.p([], [model.guide.summary]), h.p([], [model.guide.body])]),
      ]),
      h.section([h.Class("panel stack")], [
        h.h2([], ["Available guides"]),
        h.p([], ["Each returned guide is entitlement-checked; unavailable entries fail rather than being silently hidden."]),
        dataTable(h, { caption: "Guides returned by guides.list", columns: ["Title", "Summary", ""], rows: model.guides.items, key: (guide) => guide.id, cells: (guide) => [
          guide.title, guide.summary, quietButton(h, { label: "Open", message: Message.SelectedGuide({ id: guide.id }), disabled: false }),
        ] }),
        model.guides.nextCursor === null ? h.empty : primaryButton(h, { label: "Load more", message: Option.some(Message.ClickedMore()), type: "button", disabled: Requests.pending(model.requests, "guides.list") }),
      ]),
    ])],
  }),
})
