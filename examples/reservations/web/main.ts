import { DateTime, Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
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
import { Form } from "@effect-domains/example-web/form"
import { formatRpcError } from "@effect-domains/example-web/rpc"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { Requests, RequestStateSchema, RequestTokenSchema } from "@effect-domains/example-web/requests"
import { InventoryOperations } from "../sqlite.ts"
import { QuantitySchema, ReservationSchema, StockSchema } from "../domain.ts"
import { ReservationResource, StockResource } from "../resources.ts"

const ReservationWebRpcs = InventoryOperations.group
  .merge(StockResource.group)
  .merge(ReservationResource.group)

export const WebClient = RpcService.make({ name: "reservations/WebClient", group: ReservationWebRpcs })
export type WebClient = Type<typeof WebClient>

export const Model = Schema.Struct({
  stock: Schema.NullOr(StockSchema),
  reservation: Schema.NullOr(ReservationSchema),
  sku: Schema.String,
  quantity: Schema.String,
  reservationId: Schema.String,
  requests: RequestStateSchema,
  notice: Schema.NullOr(Schema.Struct({
    kind: Schema.Literals(["info", "error", "success"]),
    text: Schema.String,
  })),
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

const requestEffect = <A, E, Success extends Message>(request: typeof RequestTokenSchema.Type, effect: Effect.Effect<A, E, WebClient>, onSuccess: (value: A) => Success) =>
  pipe(effect, Effect.match({
    onSuccess,
    onFailure: (error) => Message.Failed({ request, error: formatRpcError(error) }),
  }))

export const GetStock = Command.define("GetStock", {
  args: { request: RequestTokenSchema, sku: Schema.String },
  messages: [Message.SucceededStock, Message.Failed],
  execute: ({ request, sku }) => requestEffect(
    request,
    Effect.gen(function* () {
      const client = yield* WebClient
      const key = yield* Schema.decodeUnknownEffect(StockSchema.fields.sku)(sku)
      return yield* client["stock.get"]({ sku: key })
    }),
    (stock) => Message.SucceededStock({ request, stock }),
  ),
})

export const GetReservation = Command.define("GetReservation", {
  args: { request: RequestTokenSchema, id: Schema.String },
  messages: [Message.SucceededLoadedReservation, Message.Failed],
  execute: ({ request, id }) => requestEffect(
    request,
    Effect.gen(function* () {
      const client = yield* WebClient
      const key = yield* Schema.decodeUnknownEffect(ReservationSchema.fields.id)(id)
      return yield* client["reservations.get"]({ id: key })
    }),
    (reservation) => Message.SucceededLoadedReservation({ request, reservation }),
  ),
})

export const Reserve = Command.define("Reserve", {
  args: { request: RequestTokenSchema, sku: Schema.String, quantity: Schema.String },
  messages: [Message.SucceededReservation, Message.Failed],
  execute: ({ request, sku, quantity }) => requestEffect(
    request,
    Effect.gen(function*() {
      const decodedQuantity = yield* Schema.decodeUnknownEffect(Form.integer(QuantitySchema))(quantity)
      const client = yield* WebClient
      const key = yield* Schema.decodeUnknownEffect(StockSchema.fields.sku)(sku)
      return yield* client.reserve({ sku: key, quantity: decodedQuantity })
    }),
    (reservation) => Message.SucceededReservation({ request, reservation, action: "Reservation held." }),
  ),
})

const transition = (name: "confirm" | "release", action: string) => Command.define(name, {
  args: { request: RequestTokenSchema, id: ReservationSchema.fields.id },
  messages: [Message.SucceededReservation, Message.Failed],
  execute: ({ request, id }) => requestEffect(
    request,
    pipe(WebClient, Effect.flatMap((client) => client[name]({ id }))),
    (reservation) => Message.SucceededReservation({ request, reservation, action }),
  ),
})

export const Confirm = transition("confirm", "Reservation confirmed.")
export const Release = transition("release", "Reservation released and stock restored.")

const starts = (model: Model, key: string) => Requests.start(model.requests, key)
const requestPending = (model: Model, key?: string) => Requests.pending(model.requests, key)

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedSku: ({ value }) => ({ model: evo(model, { sku: () => value, stock: () => null, requests: (current) => Requests.invalidate(current, "stock"), notice: () => null }) }),
    ChangedQuantity: ({ value }) => ({ model: evo(model, { quantity: () => value }) }),
    ChangedReservationId: ({ value }) => ({ model: evo(model, { reservationId: () => value, reservation: () => null, requests: (current) => Requests.invalidate(current, "reservation"), notice: () => null }) }),
    ClickedReloadStock: () => {
      const sku = model.sku.trim()
      if (sku === "") return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Enter a SKU." }) }) }
      const { state, request } = starts(model, "stock")
      return { model: evo(model, { requests: () => state, notice: () => null }), commands: [GetStock({ request, sku })] }
    },
    ClickedReserve: () => {
      const sku = model.sku.trim()
      if (sku === "") return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Enter a SKU." }) }) }
      const { state, request } = starts(model, "reserve")
      return { model: evo(model, { requests: () => state, notice: () => null }), commands: [Reserve({ request, sku, quantity: model.quantity })] }
    },
    ClickedGetReservation: () => {
      const id = model.reservationId.trim()
      if (id === "") return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Enter a reservation ID." }) }) }
      const { state, request } = starts(model, "reservation")
      return { model: evo(model, { requests: () => state, notice: () => null }), commands: [GetReservation({ request, id })] }
    },
    ClickedConfirm: () => {
      if (model.reservation === null) return { model }
      const { state, request } = starts(model, "transition")
      return { model: evo(model, { requests: () => state, notice: () => null }), commands: [Confirm({ request, id: model.reservation.id })] }
    },
    ClickedRelease: () => {
      if (model.reservation === null) return { model }
      const { state, request } = starts(model, "transition")
      return { model: evo(model, { requests: () => state, notice: () => null }), commands: [Release({ request, id: model.reservation.id })] }
    },
    SucceededStock: ({ request, stock }) => Requests.accepts(model.requests, request)
      ? { model: evo(model, { stock: () => stock, requests: (current) => Requests.succeed(current, request) }) }
      : { model },
    SucceededLoadedReservation: ({ request, reservation }) => Requests.accepts(model.requests, request)
      ? { model: evo(model, { reservation: () => reservation, reservationId: () => reservation.id, requests: (current) => Requests.succeed(current, request), notice: () => ({ kind: "success" as const, text: "Reservation loaded." }) }) }
      : { model },
    SucceededReservation: ({ request, reservation, action }) => {
      if (!Requests.accepts(model.requests, request)) return { model }
      const settled = evo(model, { reservation: () => reservation, reservationId: () => reservation.id, requests: (current) => Requests.succeed(current, request), notice: () => ({ kind: "success" as const, text: action }) })
      const stockRequest = starts(settled, "stock")
      return { model: evo(settled, { requests: () => stockRequest.state }), commands: [GetStock({ request: stockRequest.request, sku: settled.sku.trim() })] }
    },
    Failed: ({ request, error }) => Requests.accepts(model.requests, request)
      ? { model: evo(model, { requests: (current) => Requests.fail(current, request, error), notice: () => ({ kind: "error" as const, text: error }) }) }
      : { model },
  })

export const init: Runtime.ApplicationInit<Model, Message, void, WebClient> = () => {
  const model: Model = { stock: null, reservation: null, sku: "book", quantity: "1", reservationId: "", requests: Requests.empty(), notice: null }
  const { state, request } = starts(model, "stock")
  return { model: evo(model, { requests: () => state }), commands: [GetStock({ request, sku: model.sku })] }
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
