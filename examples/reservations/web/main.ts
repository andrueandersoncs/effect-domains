import { Effect, Option, Schema, pipe } from "effect"
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
import { rpcCall } from "@effect-domains/example-web/rpc"

const StockSchema = Schema.Struct({
  sku: Schema.String,
  available: Schema.Int,
})

const ReservationSchema = Schema.Struct({
  id: Schema.String,
  sku: Schema.String,
  quantity: Schema.Int,
  status: Schema.Literals(["held", "confirmed", "released"]),
  createdAt: Schema.String,
})

type Stock = typeof StockSchema.Type
type Reservation = typeof ReservationSchema.Type

export const Model = Schema.Struct({
  stock: Schema.NullOr(StockSchema),
  reservation: Schema.NullOr(ReservationSchema),
  sku: Schema.String,
  quantity: Schema.String,
  reservationId: Schema.String,
  busy: Schema.Boolean,
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
  SucceededStock: { stock: StockSchema },
  SucceededLoadedReservation: { reservation: ReservationSchema },
  SucceededReservation: { reservation: ReservationSchema, action: Schema.String },
  Failed: { error: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message>

export const GetStock = Command.define("GetStock", {
  args: { sku: Schema.String },
  messages: [Message.SucceededStock, Message.Failed],
  execute: ({ sku }) =>
    pipe(
      rpcCall({
        tag: "stock.get",
        payload: { sku },
        token: null,
        success: StockSchema,
      }),
      Effect.match({
        onSuccess: (stock) => Message.SucceededStock({ stock }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const GetReservation = Command.define("GetReservation", {
  args: { id: Schema.String },
  messages: [Message.SucceededLoadedReservation, Message.Failed],
  execute: ({ id }) =>
    pipe(
      rpcCall({
        tag: "reservations.get",
        payload: { id },
        token: null,
        success: ReservationSchema,
      }),
      Effect.match({
        onSuccess: (reservation) => Message.SucceededLoadedReservation({ reservation }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const Reserve = Command.define("Reserve", {
  args: { sku: Schema.String, quantity: Schema.Int },
  messages: [Message.SucceededReservation, Message.Failed],
  execute: ({ sku, quantity }) =>
    pipe(
      rpcCall({
        tag: "reserve",
        payload: { sku, quantity },
        token: null,
        success: ReservationSchema,
      }),
      Effect.match({
        onSuccess: (reservation) => Message.SucceededReservation({ reservation, action: "Reservation held." }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

const transition = (tag: "confirm" | "release", action: string) => Command.define(tag, {
  args: { id: Schema.String },
  messages: [Message.SucceededReservation, Message.Failed],
  execute: ({ id }) =>
    pipe(
      rpcCall({
        tag,
        payload: { id },
        token: null,
        success: ReservationSchema,
      }),
      Effect.match({
        onSuccess: (reservation) => Message.SucceededReservation({ reservation, action }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const Confirm = transition("confirm", "Reservation confirmed.")
export const Release = transition("release", "Reservation released and stock restored.")

const validQuantity = (value: string) => {
  const quantity = Number(value)
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null
}

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedSku: ({ value }) => ({ model: evo(model, { sku: () => value }) }),
    ChangedQuantity: ({ value }) => ({ model: evo(model, { quantity: () => value }) }),
    ChangedReservationId: ({ value }) => ({ model: evo(model, { reservationId: () => value }) }),
    ClickedReloadStock: () => {
      const sku = model.sku.trim()
      if (sku === "") return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Enter a SKU." }) }) }
      return {
        model: evo(model, { busy: () => true, notice: () => null }),
        commands: [GetStock({ sku })],
      }
    },
    ClickedReserve: () => {
      const sku = model.sku.trim()
      const quantity = validQuantity(model.quantity)
      if (sku === "") return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Enter a SKU." }) }) }
      if (quantity === null) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Quantity must be a positive whole number." }) }) }
      return {
        model: evo(model, { busy: () => true, notice: () => null }),
        commands: [Reserve({ sku, quantity })],
      }
    },
    ClickedGetReservation: () => {
      const id = model.reservationId.trim()
      if (id === "") return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Enter a reservation ID." }) }) }
      return {
        model: evo(model, { busy: () => true, notice: () => null }),
        commands: [GetReservation({ id })],
      }
    },
    ClickedConfirm: () => {
      if (model.reservation === null) return { model }
      return {
        model: evo(model, { busy: () => true, notice: () => null }),
        commands: [Confirm({ id: model.reservation.id })],
      }
    },
    ClickedRelease: () => {
      if (model.reservation === null) return { model }
      return {
        model: evo(model, { busy: () => true, notice: () => null }),
        commands: [Release({ id: model.reservation.id })],
      }
    },
    SucceededStock: ({ stock }) => ({
      model: evo(model, { stock: () => stock, busy: () => false }),
    }),
    SucceededLoadedReservation: ({ reservation }) => ({
      model: evo(model, {
        reservation: () => reservation,
        reservationId: () => reservation.id,
        busy: () => false,
        notice: () => ({ kind: "success" as const, text: "Reservation loaded." }),
      }),
    }),
    SucceededReservation: ({ reservation, action }) => ({
      model: evo(model, {
        reservation: () => reservation,
        reservationId: () => reservation.id,
        busy: () => true,
        notice: () => ({ kind: "success" as const, text: action }),
      }),
      commands: [GetStock({ sku: model.sku.trim() })],
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
    stock: null,
    reservation: null,
    sku: "book",
    quantity: "1",
    reservationId: "",
    busy: true,
    notice: null,
  },
  commands: [GetStock({ sku: "book" })],
})

const reservationCard = (reservation: Reservation, model: Model, h: HtmlBuilder<Message>) => h.div(
  [h.Class("stack")],
  [
    h.p([], [`${reservation.quantity} × ${reservation.sku}`]),
    h.p([], [`Status: ${reservation.status}`]),
    h.p([], [`ID: ${reservation.id}`]),
    h.p([], [`Created: ${reservation.createdAt}`]),
    h.div(
      [h.Class("actions")],
      [
        primaryButton(h, {
          label: "Confirm",
          message: Option.some(Message.ClickedConfirm()),
          type: "button",
          disabled: model.busy || reservation.status !== "held",
        }),
        quietButton(h, {
          label: "Release",
          message: Message.ClickedRelease(),
          disabled: model.busy || reservation.status !== "held",
        }),
      ],
    ),
  ],
)

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Reservations",
  body: shell(h, {
    title: "Reservations",
    lede: "Reserve the seeded book SKU, then confirm it or release the hold. This page uses the same public RPC as the CLI.",
    notice: model.notice,
    session: null,
    children: [
      h.div(
        [h.Class("split")],
        [
          h.section(
            [h.Class("panel stack")],
            [
              h.h2([], ["Stock"]),
              h.p([], [model.stock === null ? "Loading stock…" : `${model.stock.sku}: ${model.stock.available} available`]),
              h.form(
                [h.Class("actions"), h.OnSubmit(Message.ClickedReloadStock())],
                [
                  field(h, {
                    id: "sku",
                    label: "SKU",
                    children: textInput(h, {
                      id: "sku",
                      value: model.sku,
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                      onInput: (value) => Message.ChangedSku({ value }),
                    }),
                  }),
                  primaryButton(h, { label: model.busy ? "Loading…" : "Refresh stock", message: Option.none(), type: "submit", disabled: model.busy }),
                ],
              ),
              h.form(
                [h.Class("stack"), h.OnSubmit(Message.ClickedReserve())],
                [
                  h.h2([], ["Reserve stock"]),
                  field(h, {
                    id: "quantity",
                    label: "Quantity",
                    children: textInput(h, {
                      id: "quantity",
                      value: model.quantity,
                      type: "number",
                      placeholder: "",
                      autocomplete: "off",
                      onInput: (value) => Message.ChangedQuantity({ value }),
                    }),
                  }),
                  primaryButton(h, { label: "Reserve", message: Option.none(), type: "submit", disabled: model.busy }),
                ],
              ),
            ],
          ),
          h.section(
            [h.Class("panel stack")],
            [
              h.form(
                [h.Class("stack"), h.OnSubmit(Message.ClickedGetReservation())],
                [
                  h.h2([], ["Find reservation"]),
                  field(h, {
                    id: "reservation-id",
                    label: "Reservation ID",
                    children: textInput(h, {
                      id: "reservation-id",
                      value: model.reservationId,
                      type: "text",
                      placeholder: "UUID v7",
                      autocomplete: "off",
                      onInput: (value) => Message.ChangedReservationId({ value }),
                    }),
                  }),
                  primaryButton(h, { label: "Load reservation", message: Option.none(), type: "submit", disabled: model.busy }),
                ],
              ),
              h.div(
                [h.Class("stack")],
                [
                  h.h2([], ["Last reservation"]),
                  model.reservation === null
                    ? h.p([], ["Reserve stock or load a reservation by ID."])
                    : reservationCard(model.reservation, model, h),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  }),
})
