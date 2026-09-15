import { DateTime, Effect, Option, Schema, pipe } from "effect"
import { Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import {
  field,
  primaryButton,
  quietButton,
  shell,
  textInput,
} from "@effect-domains/example-web/html"
import { BrowserModel } from "effect-domains/browser-model"
import { Form } from "effect-domains/form"
import { Resource } from "effect-domains/resource"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { Requests, RequestStateSchema, RequestTokenSchema } from "effect-domains/requests"
import { InventoryOperations } from "../sqlite.ts"
import { QuantitySchema, ReservationSchema, StockSchema } from "../domain.ts"
import { ReservationResource, StockResource } from "../resources.ts"

const ReservationWebRpcs = InventoryOperations.group
  .merge(Resource.compile(StockResource).group)
  .merge(Resource.compile(ReservationResource).group)

export const WebClient = RpcService.make({ name: "reservations/WebClient", group: ReservationWebRpcs })
export type WebClient = Type<typeof WebClient>

export const Model = Schema.Struct({
  stock: Schema.NullOr(StockSchema),
  reservation: Schema.NullOr(ReservationSchema),
  sku: Schema.String,
  quantity: Schema.String,
  reservationId: Schema.String,
  requests: RequestStateSchema,
  notice: BrowserModel.NoticeSchema,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedSku: { value: Schema.String },
  ChangedQuantity: { value: Schema.String },
  ChangedReservationId: { value: Schema.String },
  ClickedReloadStock: {},
  ClickedReserve: {},
  ClickedGetReservation: {},
  ClickedConfirm: {},
  ClickedRelease: {},
  SucceededStock: { request: RequestTokenSchema, stock: StockSchema },
  SucceededLoadedReservation: { request: RequestTokenSchema, reservation: ReservationSchema },
  SucceededReservation: { request: RequestTokenSchema, reservation: ReservationSchema, action: Schema.String },
  Failed: { request: RequestTokenSchema, error: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message, WebClient>

export const GetStock = RpcBrowser.command("GetStock", {
  request: "stock",
  args: { sku: Schema.String },
  success: Message.SucceededStock,
  failure: Message.Failed,
  execute: ({ sku }) => Effect.gen(function* () {
    const client = yield* WebClient
    const key = yield* Schema.decodeUnknownEffect(StockSchema.fields.sku)(sku)
    const stock = yield* client["stock.get"]({ sku: key })

    return { stock }
  }),
})

export const GetReservation = RpcBrowser.command("GetReservation", {
  request: "reservation",
  args: { id: Schema.String },
  success: Message.SucceededLoadedReservation,
  failure: Message.Failed,
  execute: ({ id }) => Effect.gen(function* () {
    const client = yield* WebClient
    const key = yield* Schema.decodeUnknownEffect(ReservationSchema.fields.id)(id)
    const reservation = yield* client["reservations.get"]({ id: key })

    return { reservation }
  }),
})

export const Reserve = RpcBrowser.command("Reserve", {
  request: "reserve",
  args: { sku: Schema.String, quantity: Schema.String },
  success: Message.SucceededReservation,
  failure: Message.Failed,
  execute: ({ sku, quantity }) => Effect.gen(function* () {
    const decodedQuantity = yield* Schema.decodeUnknownEffect(Form.integer(QuantitySchema))(quantity)
    const client = yield* WebClient
    const key = yield* Schema.decodeUnknownEffect(StockSchema.fields.sku)(sku)
    const reservation = yield* client.reserve({ sku: key, quantity: decodedQuantity })

    return { reservation, action: "Reservation held." }
  }),
})

const transition = (name: "confirm" | "release", action: string) => RpcBrowser.command(name, {
  request: "transition",
  args: { id: ReservationSchema.fields.id },
  success: Message.SucceededReservation,
  failure: Message.Failed,
  execute: ({ id }) => pipe(
    WebClient,
    Effect.flatMap((client) => client[name]({ id })),
    Effect.map((reservation) => ({ reservation, action })),
  ),
})

export const Confirm = transition("confirm", "Reservation confirmed.")
export const Release = transition("release", "Reservation released and stock restored.")

const requestPending = (model: Model, ...keys: [] | [string]) => RpcBrowser.pending(model, ...keys)

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedSku: ({ value }) => RpcBrowser.invalidate(model, GetStock.requestKey, { sku: value, stock: null, notice: null }),
    ChangedQuantity: ({ value }) => ({ model: evo(model, { quantity: () => value }) }),
    ChangedReservationId: ({ value }) => RpcBrowser.invalidate(model, GetReservation.requestKey, { reservationId: value, reservation: null, notice: null }),
    ClickedReloadStock: () => {
      const sku = model.sku.trim()
      if (sku === "") return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Enter a SKU." }) }) }
      return GetStock.start(model, { sku }, { notice: null })
    },
    ClickedReserve: () => {
      const sku = model.sku.trim()
      if (sku === "") return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Enter a SKU." }) }) }
      return Reserve.start(model, { sku, quantity: model.quantity }, { notice: null })
    },
    ClickedGetReservation: () => {
      const id = model.reservationId.trim()
      if (id === "") return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Enter a reservation ID." }) }) }
      return GetReservation.start(model, { id }, { notice: null })
    },
    ClickedConfirm: () => {
      if (model.reservation === null) return { model }
      return Confirm.start(model, { id: model.reservation.id }, { notice: null })
    },
    ClickedRelease: () => {
      if (model.reservation === null) return { model }
      return Release.start(model, { id: model.reservation.id }, { notice: null })
    },
    SucceededStock: ({ request, stock }) => RpcBrowser.succeed(model, request, { stock }),
    SucceededLoadedReservation: ({ request, reservation }) => RpcBrowser.succeed(model, request, {
      reservation,
      reservationId: reservation.id,
      notice: { kind: "success" as const, text: "Reservation loaded." },
    }),
    SucceededReservation: ({ request, reservation, action }) => {
      const settled = RpcBrowser.succeed(model, request, {
        reservation,
        reservationId: reservation.id,
        notice: { kind: "success" as const, text: action },
      })
      if (!settled.accepted) return { model }

      return GetStock.start(settled.model, { sku: settled.model.sku.trim() })
    },
    Failed: ({ request, error }) => RpcBrowser.fail(model, request, error, {
      notice: { kind: "error" as const, text: error },
    }),
  })

export const init: Runtime.ApplicationInit<Model, Message, void, WebClient> = () => {
  const model: Model = { stock: null, reservation: null, sku: "book", quantity: "1", reservationId: "", requests: Requests.empty(), notice: null }
  return GetStock.start(model, { sku: model.sku })
}

const reservationCard = (reservation: typeof ReservationSchema.Type, model: Model, h: HtmlBuilder<Message>) => h.div(
  [h.Class("stack")],
  [
    h.p([], [`${reservation.quantity} × ${reservation.sku}`]),
    h.p([], [`Status: ${reservation.status}`]),
    h.p([], [`ID: ${reservation.id}`]),
    h.p([], [`Created: ${DateTime.formatIso(reservation.createdAt)}`]),
    h.div([h.Class("actions")], [
      primaryButton(h, { label: "Confirm", message: Option.some(Message.ClickedConfirm()), type: "button", disabled: requestPending(model, "transition") || reservation.status !== "held" }),
      quietButton(h, { label: "Release", message: Message.ClickedRelease(), disabled: requestPending(model, "transition") || reservation.status !== "held" }),
    ]),
  ],
)

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Reservations",
  body: shell(h, {
    title: "Reservations",
    lede: "Reserve the seeded book SKU, then confirm it or release the hold. This page uses the same public RPC as the CLI.",
    notice: model.notice,
    session: null,
    children: [h.div([h.Class("split")], [
      h.section([h.Class("panel stack")], [
        h.h2([], ["Stock"]),
        h.p([], [model.stock === null ? "Loading stock…" : `${model.stock.sku}: ${model.stock.available} available`]),
        h.form([h.Class("actions"), h.OnSubmit(Message.ClickedReloadStock())], [
          field(h, { id: "sku", label: "SKU", children: textInput(h, { id: "sku", value: model.sku, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedSku({ value }) }) }),
          primaryButton(h, { label: requestPending(model, "stock") ? "Loading…" : "Refresh stock", message: Option.none(), type: "submit", disabled: requestPending(model, "stock") }),
        ]),
        h.form([h.Class("stack"), h.OnSubmit(Message.ClickedReserve())], [
          h.h2([], ["Reserve stock"]),
          field(h, { id: "quantity", label: "Quantity", children: textInput(h, { id: "quantity", value: model.quantity, type: "number", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedQuantity({ value }) }) }),
          primaryButton(h, { label: "Reserve", message: Option.none(), type: "submit", disabled: requestPending(model, "reserve") }),
        ]),
      ]),
      h.section([h.Class("panel stack")], [
        h.form([h.Class("stack"), h.OnSubmit(Message.ClickedGetReservation())], [
          h.h2([], ["Find reservation"]),
          field(h, { id: "reservation-id", label: "Reservation ID", children: textInput(h, { id: "reservation-id", value: model.reservationId, type: "text", placeholder: "UUID v7", autocomplete: "off", onInput: (value) => Message.ChangedReservationId({ value }) }) }),
          primaryButton(h, { label: "Load reservation", message: Option.none(), type: "submit", disabled: requestPending(model, "reservation") }),
        ]),
        h.div([h.Class("stack")], [h.h2([], ["Last reservation"]), model.reservation === null ? h.p([], ["Reserve stock or load a reservation by ID."]) : reservationCard(model.reservation, model, h)]),
      ]),
    ])],
  }),
})
