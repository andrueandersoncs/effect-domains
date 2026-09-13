import { Array, Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import { dataTable, field, primaryButton, quietButton, selectInput, shell, textInput } from "@effect-domains/example-web/html"
import { BrowserModel } from "effect-domains/browser-model"
import { Form } from "effect-domains/form"
import { Page } from "effect-domains/page"
import { ResourcePager } from "effect-domains/resource-pager"
import { Requests, RequestStateSchema, RequestTokenSchema, type RequestToken } from "effect-domains/requests"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { AssetConditionSchema, AssetSchema } from "../domain.ts"
import { AssetsResource } from "../resources.ts"

const AssetRowSchema = AssetsResource.table.rowSchema
const AssetPageSchema = AssetsResource.contracts.list.successSchema
export const WebClient = RpcService.make({ name: "equipment-register/WebClient", group: AssetsResource.group })
export type WebClient = Type<typeof WebClient>
const conditions = ["in-service", "needs-repair", "retired"] as const
const conditionChoices = [{ value: "", label: "Any condition" }, ...Array.map(conditions, (value) => ({ value, label: value }))]
const formConditionChoices = Array.map(conditions, (value) => ({ value, label: value }))
export const Model = Schema.Struct({
  assets: Schema.Array(AssetRowSchema), nextCursor: Schema.NullOr(Schema.String), filterAssetTag: Schema.String, filterLocation: Schema.String, filterCondition: Schema.String,
  assetTag: Schema.String, name: Schema.String, model: Schema.String, serial: Schema.String, location: Schema.String, condition: AssetConditionSchema, selectedId: Schema.NullOr(Schema.String),
  requests: RequestStateSchema, fieldErrors: BrowserModel.FieldErrorsSchema, notice: BrowserModel.NoticeSchema,
})
export type Model = typeof Model.Type
export const Message = defineMessageUnion({
  ChangedFilterAssetTag: { value: Schema.String }, ChangedFilterLocation: { value: Schema.String }, ChangedFilterCondition: { value: Schema.String }, ChangedAssetTag: { value: Schema.String }, ChangedName: { value: Schema.String }, ChangedModel: { value: Schema.String }, ChangedSerial: { value: Schema.String }, ChangedLocation: { value: Schema.String }, ChangedCondition: { value: Schema.String },
  ClickedReload: {}, ClickedNext: {}, ClickedSave: {}, ClickedNew: {}, ClickedSelect: { id: Schema.String }, ClickedRemove: { id: Schema.String },
  SucceededList: { page: AssetPageSchema, append: Schema.Boolean, request: RequestTokenSchema }, SucceededSave: { asset: AssetRowSchema, created: Schema.Boolean, request: RequestTokenSchema }, SucceededRemove: { id: Schema.String, request: RequestTokenSchema }, Failed: { request: RequestTokenSchema, error: Schema.String, fieldErrors: BrowserModel.FieldErrorsSchema },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient>
const failed = (request: RequestToken, error: unknown) =>
  Message.Failed({ request, ...BrowserModel.failure(error, RpcBrowser.messageFromUnknown) })
const emptyForm = { assetTag: "", name: "", model: "", serial: "", location: "", condition: "in-service" as const, selectedId: null as string | null }

export const ListAssets = Command.define("ListAssets", {
  args: { filterAssetTag: Schema.String, filterLocation: Schema.String, filterCondition: Schema.String, cursor: Schema.NullOr(Schema.String), append: Schema.Boolean, request: RequestTokenSchema }, messages: [Message.SucceededList, Message.Failed],
  execute: (args) => Effect.gen(function*() {
    const client = yield* WebClient
    const page = yield* client["assets.list"]({ filter: { ...(args.filterAssetTag.trim() === "" ? {} : { assetTag: args.filterAssetTag.trim() }), ...(args.filterLocation.trim() === "" ? {} : { location: args.filterLocation.trim() }), ...(args.filterCondition === "" ? {} : { condition: args.filterCondition as typeof AssetConditionSchema.Type }) }, limit: 100, ...Page.input(args.cursor) })
    return Message.SucceededList({ page, append: args.append, request: args.request })
  }).pipe(Effect.catch((error) => Effect.succeed(failed(args.request, error)))),
})
export const SaveAsset = Command.define("SaveAsset", {
  args: { selectedId: Schema.NullOr(Schema.String), assetTag: Schema.String, name: Schema.String, model: Schema.String, serial: Schema.String, location: Schema.String, condition: AssetConditionSchema, request: RequestTokenSchema }, messages: [Message.SucceededSave, Message.Failed],
  execute: (args) => Effect.gen(function*() {
    const assetTag = yield* Schema.decodeUnknownEffect(AssetSchema.fields.assetTag)(args.assetTag.trim()).pipe(Effect.mapError(BrowserModel.fieldFailure("assetTag")))
    const name = yield* Schema.decodeUnknownEffect(AssetSchema.fields.name)(args.name.trim()).pipe(Effect.mapError(BrowserModel.fieldFailure("name")))
    const model = yield* Schema.decodeUnknownEffect(AssetSchema.fields.model)(args.model.trim()).pipe(Effect.mapError(BrowserModel.fieldFailure("model")))
    const serial = yield* Schema.decodeUnknownEffect(Form.nullableText(Schema.NonEmptyString))(args.serial).pipe(Effect.mapError(BrowserModel.fieldFailure("serial")))
    const location = yield* Schema.decodeUnknownEffect(AssetSchema.fields.location)(args.location.trim()).pipe(Effect.mapError(BrowserModel.fieldFailure("location")))
    const client = yield* WebClient
    const asset = { assetTag, name, model, serial, location, condition: args.condition }
    const created = args.selectedId === null
    const saved = yield* (created ? client["assets.create"](asset) : client["assets.update"]({ id: args.selectedId, ...asset }))
    return Message.SucceededSave({ asset: saved, created, request: args.request })
  }).pipe(Effect.catch((error) => Effect.succeed(failed(args.request, error)))),
})
export const RemoveAsset = Command.define("RemoveAsset", { args: { id: Schema.String, request: RequestTokenSchema }, messages: [Message.SucceededRemove, Message.Failed], execute: ({ id, request }) => Effect.gen(function*() { const client = yield* WebClient; yield* client["assets.remove"]({ id }); return Message.SucceededRemove({ id, request }) }).pipe(Effect.catch((error) => Effect.succeed(failed(request, error)))) })
const AssetsPager = ResourcePager.make("assets.list")
const assetsState = (model: Model) => ({ page: { items: model.assets, nextCursor: model.nextCursor }, requests: model.requests })
const list = (model: Model, request: RequestToken, cursor: string | null, append: boolean) =>
  ListAssets({ filterAssetTag: model.filterAssetTag, filterLocation: model.filterLocation, filterCondition: model.filterCondition, cursor, append, request })
const beginList = (model: Model, append: boolean) => {
  const started = pipe(AssetsPager.begin(model.requests, assetsState(model).page, append), Option.getOrThrow)
  return {
    page: started.page,
    state: started.requests,
    command: list(model, started.request, started.cursor, started.append),
  }
}

export const update = (model: Model, message: Message) => Message.match<UpdateReturn>(message, {
  ChangedFilterAssetTag: ({ value }) => {
    const invalidated = AssetsPager.invalidate(assetsState(model))
    return { model: evo(model, { filterAssetTag: () => value, assets: () => invalidated.page.items, nextCursor: () => invalidated.page.nextCursor, requests: () => invalidated.requests }) }
  },
  ChangedFilterLocation: ({ value }) => {
    const invalidated = AssetsPager.invalidate(assetsState(model))
    return { model: evo(model, { filterLocation: () => value, assets: () => invalidated.page.items, nextCursor: () => invalidated.page.nextCursor, requests: () => invalidated.requests }) }
  },
  ChangedFilterCondition: ({ value }) => {
    const invalidated = AssetsPager.invalidate(assetsState(model))
    return { model: evo(model, { filterCondition: () => value, assets: () => invalidated.page.items, nextCursor: () => invalidated.page.nextCursor, requests: () => invalidated.requests }) }
  },
  ChangedAssetTag: ({ value }) => ({ model: evo(model, { assetTag: () => value }) }),
  ChangedName: ({ value }) => ({ model: evo(model, { name: () => value }) }),
  ChangedModel: ({ value }) => ({ model: evo(model, { model: () => value }) }),
  ChangedSerial: ({ value }) => ({ model: evo(model, { serial: () => value }) }),
  ChangedLocation: ({ value }) => ({ model: evo(model, { location: () => value }) }),
  ChangedCondition: ({ value }) => ({ model: evo(model, { condition: () => value as Model["condition"] }) }),
  ClickedReload: () => {
    const listing = beginList(model, false)
    return { model: evo(model, { assets: () => listing.page.items, nextCursor: () => listing.page.nextCursor, requests: () => listing.state, notice: () => null }), commands: [listing.command] }
  },
  ClickedNext: () => {
    if (model.nextCursor === null || AssetsPager.pending(model.requests)) return { model }
    const listing = beginList(model, true)
    return { model: evo(model, { assets: () => listing.page.items, nextCursor: () => listing.page.nextCursor, requests: () => listing.state }), commands: [listing.command] }
  },
  ClickedSave: () => { const started = Requests.start(model.requests, "assets.save"); return { model: evo(model, { requests: () => started.state, fieldErrors: () => ({}), notice: () => null }), commands: [SaveAsset({ selectedId: model.selectedId, assetTag: model.assetTag, name: model.name, model: model.model, serial: model.serial, location: model.location, condition: model.condition, request: started.request })] } },
  ClickedNew: () => ({ model: evo(model, { assetTag: () => "", name: () => "", model: () => "", serial: () => "", location: () => "", condition: () => "in-service", selectedId: () => null, fieldErrors: () => ({}), notice: () => null }) }),
  ClickedSelect: ({ id }) => Option.match(Array.findFirst(model.assets, (asset) => asset.id === id), { onNone: () => ({ model }), onSome: (asset) => ({ model: evo(model, { assetTag: () => asset.assetTag, name: () => asset.name, model: () => asset.model, serial: () => asset.serial ?? "", location: () => asset.location, condition: () => asset.condition, selectedId: () => asset.id, fieldErrors: () => ({}), notice: () => null }) }) }),
  ClickedRemove: ({ id }) => { const started = Requests.start(model.requests, "assets.remove"); return { model: evo(model, { requests: () => started.state, notice: () => null }), commands: [RemoveAsset({ id, request: started.request })] } },
  SucceededList: ({ page, append, request }) => Option.match(AssetsPager.receive(assetsState(model), request, page, append), {
    onNone: () => ({ model }),
    onSome: (received) => ({ model: evo(model, { assets: () => received.page.items, nextCursor: () => received.page.nextCursor, requests: () => received.requests }) }),
  }),
  SucceededSave: ({ asset, created, request }) => {
    if (!Requests.accepts(model.requests, request)) return { model }
    const listing = beginList(evo(model, { requests: () => Requests.succeed(model.requests, request) }), false)
    return { model: evo(model, { assetTag: () => asset.assetTag, name: () => asset.name, model: () => asset.model, serial: () => asset.serial ?? "", location: () => asset.location, condition: () => asset.condition, selectedId: () => asset.id, assets: () => listing.page.items, nextCursor: () => listing.page.nextCursor, requests: () => listing.state, notice: () => ({ kind: "success" as const, text: created ? "Asset registered." : "Asset updated." }) }), commands: [listing.command] }
  },
  SucceededRemove: ({ id, request }) => {
    if (!Requests.accepts(model.requests, request)) return { model }
    const base = evo(model, { requests: () => Requests.succeed(model.requests, request) })
    const listing = beginList(base, false)
    const selected = model.selectedId === id
    return { model: evo(model, { assetTag: () => selected ? "" : model.assetTag, name: () => selected ? "" : model.name, model: () => selected ? "" : model.model, serial: () => selected ? "" : model.serial, location: () => selected ? "" : model.location, condition: () => selected ? "in-service" : model.condition, selectedId: () => selected ? null : model.selectedId, assets: () => listing.page.items, nextCursor: () => listing.page.nextCursor, requests: () => listing.state, notice: () => ({ kind: "success" as const, text: "Removed." }) }), commands: [listing.command] }
  },
  Failed: ({ request, error, fieldErrors }) => !Requests.accepts(model.requests, request) ? { model } : ({ model: evo(model, { requests: () => Requests.fail(model.requests, request, error), fieldErrors: () => ({ ...model.fieldErrors, ...fieldErrors }), notice: () => ({ kind: "error" as const, text: error }) }) }),
})
export const init: Runtime.ApplicationInit<Model, Message, void, WebClient> = () => {
  const model: Model = { assets: [], nextCursor: null, filterAssetTag: "", filterLocation: "", filterCondition: "", ...emptyForm, requests: Requests.empty(), fieldErrors: BrowserModel.emptyFieldErrors(), notice: null }
  const listing = beginList(model, false)
  return { model: evo(model, { assets: () => listing.page.items, nextCursor: () => listing.page.nextCursor, requests: () => listing.state }), commands: [listing.command] }
}
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({ title: "Equipment register", body: shell(h, { title: "Equipment register", lede: "Register equipment, track where it is, and keep its service status current.", notice: model.notice, session: null, children: [h.div([h.Class("split")], [
  h.section([h.Class("panel stack")], [h.div([h.Class("actions")], [field(h, { id: "filter-asset-tag", label: "Filter tag", children: textInput(h, { id: "filter-asset-tag", value: model.filterAssetTag, onInput: (value) => Message.ChangedFilterAssetTag({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "filter-location", label: "Filter location", children: textInput(h, { id: "filter-location", value: model.filterLocation, onInput: (value) => Message.ChangedFilterLocation({ value }), type: "text", placeholder: "", autocomplete: "off" }) }), field(h, { id: "filter-condition", label: "Filter condition", children: selectInput(h, { id: "filter-condition", value: model.filterCondition, onChange: (value) => Message.ChangedFilterCondition({ value }), choices: conditionChoices }) }), primaryButton(h, { label: Requests.pending(model.requests, "assets.list") ? "Loading…" : "Reload", message: Option.some(Message.ClickedReload()), type: "button", disabled: Requests.pending(model.requests, "assets.list") })]), dataTable(h, { caption: "Assets", columns: ["Asset tag", "Name", "Model", "Serial", "Location", "Condition", ""], rows: model.assets, key: (asset) => asset.id, cells: (asset) => [asset.assetTag, asset.name, asset.model, asset.serial ?? "—", asset.location, asset.condition, h.div([h.Class("row-actions")], [quietButton(h, { label: "Edit", message: Message.ClickedSelect({ id: asset.id }), disabled: false }), quietButton(h, { label: "Remove", message: Message.ClickedRemove({ id: asset.id }), disabled: Requests.pending(model.requests, "assets.remove") })])] }), model.nextCursor === null ? h.p([], ["All asset pages loaded."]) : quietButton(h, { label: "Load more assets", message: Message.ClickedNext(), disabled: Requests.pending(model.requests, "assets.list") })]),
  h.section([h.Class("panel")], [h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSave())], [h.h2([], [model.selectedId === null ? "Register an asset" : "Edit asset"]), field(h, { id: "asset-tag", label: "Asset tag", children: textInput(h, { id: "asset-tag", value: model.assetTag, onInput: (value) => Message.ChangedAssetTag({ value }), type: "text", placeholder: "EQ-CAM2048", autocomplete: "off" }), error: model.fieldErrors.assetTag }), field(h, { id: "name", label: "Name", children: textInput(h, { id: "name", value: model.name, onInput: (value) => Message.ChangedName({ value }), type: "text", placeholder: "", autocomplete: "off" }), error: model.fieldErrors.name }), field(h, { id: "model", label: "Model", children: textInput(h, { id: "model", value: model.model, onInput: (value) => Message.ChangedModel({ value }), type: "text", placeholder: "", autocomplete: "off" }), error: model.fieldErrors.model }), field(h, { id: "serial", label: "Serial number", children: textInput(h, { id: "serial", value: model.serial, onInput: (value) => Message.ChangedSerial({ value }), type: "text", placeholder: "", autocomplete: "off" }), error: model.fieldErrors.serial }), field(h, { id: "location", label: "Location", children: textInput(h, { id: "location", value: model.location, onInput: (value) => Message.ChangedLocation({ value }), type: "text", placeholder: "", autocomplete: "off" }), error: model.fieldErrors.location }), field(h, { id: "condition", label: "Condition", children: selectInput(h, { id: "condition", value: model.condition, onChange: (value) => Message.ChangedCondition({ value }), choices: formConditionChoices }) }), h.div([h.Class("actions")], [primaryButton(h, { label: model.selectedId === null ? "Register asset" : "Save changes", message: Option.none(), type: "submit", disabled: Requests.pending(model.requests, "assets.save") }), quietButton(h, { label: "Clear", message: Message.ClickedNew(), disabled: false })]) ])]),
]) ] }) })
