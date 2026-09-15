import { Effect, Option, Schema, pipe } from "effect"
import { Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import { dataTable, field, primaryButton, quietButton, shell, textInput } from "@effect-domains/example-web/html"
import { BrowserModel } from "effect-domains/browser-model"
import { Form } from "effect-domains/form"
import { Resource } from "effect-domains/resource"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { Requests, RequestStateSchema, RequestTokenSchema } from "effect-domains/requests"
import { identitySessionView } from "@effect-domains/example-web/session"
import { IdentitySession as Session } from "effect-domains/identity-session"

import { IdentityRpcs } from "effect-domains/identity-rpc"
import { OrderSummary } from "../contracts.ts"
import {
  CreateOrderInputSchema,
  InvoiceNumberSchema,
  LineNumberSchema,
  PositiveMinorUnitsSchema,
  QuantitySchema,
} from "../domain.ts"
import { VersionConflict } from "effect-domains/repository-store"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { OrdersResource } from "../resources.ts"
import { BillingOperations } from "../sqlite.ts"

type SessionClient = Type<typeof Session.Client>

const BillingBrowserRpcs = IdentityRpcs.merge(BillingOperations.group)
const OrderSchema = Resource.table(OrdersResource).rowSchema

export const WebClient = RpcService.make({ name: "orders-invoices/WebClient", group: BillingBrowserRpcs })
export type WebClient = Type<typeof WebClient>

const integerFields = Schema.Struct({
  lineNumber: Form.integer(LineNumberSchema),
  quantity: Form.integer(QuantitySchema),
  unitAmountMinor: Form.integer(PositiveMinorUnitsSchema),
})
const errorText = (error: unknown) => error instanceof VersionConflict || (
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "VersionConflict"
)
  ? "Version conflict: this order or invoice changed. Reload it and try again."
  : RpcBrowser.messageFromUnknown(error)

export const Model = Schema.Struct({
  session: Session.ModelSchema,
  requests: RequestStateSchema,
  summary: Schema.NullOr(OrderSummary),
  orderNumber: Schema.String,
  customer: Schema.String,
  lineNumber: Schema.String,
  description: Schema.String,
  quantity: Schema.String,
  unitAmountMinor: Schema.String,
  invoiceNumber: Schema.String,
  fieldErrors: BrowserModel.FieldErrorsSchema,
  notice: BrowserModel.NoticeSchema,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  SessionChanged: { message: Session.MessageSchema },
  ChangedOrderNumber: { value: Schema.String },
  ChangedCustomer: { value: Schema.String },
  ChangedLineNumber: { value: Schema.String },
  ChangedDescription: { value: Schema.String },
  ChangedQuantity: { value: Schema.String },
  ChangedUnitAmountMinor: { value: Schema.String },
  ChangedInvoiceNumber: { value: Schema.String },
  ClickedCreate: {},
  ClickedAddLine: {},
  ClickedIssue: {},
  ClickedPay: {},
  ClickedReload: {},
  SucceededCreate: { request: RequestTokenSchema, order: OrderSchema },
  SucceededSummary: { request: RequestTokenSchema, summary: OrderSummary },
  SucceededAction: { request: RequestTokenSchema, text: Schema.String },
  Failed: {
    request: RequestTokenSchema,
    error: Schema.String,
    fieldErrors: BrowserModel.FieldErrorsSchema,
  },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient | SessionClient>

const failurePayload = (error: unknown) => BrowserModel.failure(error, errorText)

export const LoadOrder = RpcBrowser.command("LoadOrder", {
  request: "billing.load",
  args: { token: Schema.String, orderId: Schema.String },
  success: Message.SucceededSummary,
  failure: Message.Failed,
  execute: ({ token, orderId }) => pipe(
    WebClient,
    Effect.flatMap((client) =>
      client["billing.getOrder"]({ orderId }, RpcBrowser.requestOptions(token))),
    Effect.map((summary) => ({ summary })),
  ),
  failurePayload,
})

export const CreateOrder = RpcBrowser.command("CreateOrder", {
  request: "billing.create",
  args: { token: Schema.String, number: Schema.String, customer: Schema.String },
  success: Message.SucceededCreate,
  failure: Message.Failed,
  execute: ({ token, number, customer }) => pipe(
    Schema.decodeUnknownEffect(CreateOrderInputSchema)({
      number: number.trim(),
      customer: customer.trim(),
    }),
    Effect.mapError(BrowserModel.formFailure),
    Effect.flatMap((input) => WebClient.pipe(
      Effect.flatMap((client) =>
        client["billing.createOrder"](input, RpcBrowser.requestOptions(token))),
    )),
    Effect.map((order) => ({ order })),
  ),
  failurePayload,
})

export const AddLine = RpcBrowser.command("AddLine", {
  request: "billing.addLine",
  args: {
    token: Schema.String,
    orderId: Schema.String,
    expectedVersion: Schema.Int,
    lineNumber: Schema.String,
    description: Schema.String,
    quantity: Schema.String,
    unitAmountMinor: Schema.String,
  },
  success: Message.SucceededSummary,
  failure: Message.Failed,
  execute: (args) => pipe(
    Schema.decodeUnknownEffect(integerFields)({
      lineNumber: args.lineNumber,
      quantity: args.quantity,
      unitAmountMinor: args.unitAmountMinor,
    }),
    Effect.mapError(BrowserModel.formFailure),
    Effect.flatMap((numbers) => WebClient.pipe(
      Effect.flatMap((client) => client["billing.addLine"]({
        orderId: args.orderId,
        expectedVersion: args.expectedVersion,
        lineNumber: numbers.lineNumber,
        description: args.description.trim(),
        quantity: numbers.quantity,
        unitAmountMinor: numbers.unitAmountMinor,
      }, RpcBrowser.requestOptions(args.token))),
    )),
    Effect.map((summary) => ({ summary })),
  ),
  failurePayload,
})

export const IssueInvoice = RpcBrowser.command("IssueInvoice", {
  request: "billing.issue",
  args: {
    token: Schema.String,
    orderId: Schema.String,
    expectedVersion: Schema.Int,
    number: Schema.String,
  },
  success: Message.SucceededAction,
  failure: Message.Failed,
  execute: ({ token, orderId, expectedVersion, number }) => pipe(
    Schema.decodeUnknownEffect(InvoiceNumberSchema)(number.trim()),
    Effect.mapError(BrowserModel.fieldFailure("invoiceNumber")),
    Effect.flatMap((number) => WebClient.pipe(
      Effect.flatMap((client) =>
        client["billing.issueInvoice"](
          { orderId, expectedVersion, number },
          RpcBrowser.requestOptions(token),
        )),
    )),
    Effect.as({ text: "Invoice issued." }),
  ),
  failurePayload,
})

export const PayInvoice = RpcBrowser.command("PayInvoice", {
  request: "billing.pay",
  args: { token: Schema.String, invoiceId: Schema.String, expectedVersion: Schema.Int },
  success: Message.SucceededAction,
  failure: Message.Failed,
  execute: ({ token, invoiceId, expectedVersion }) => pipe(
    WebClient,
    Effect.flatMap((client) =>
      client["billing.payInvoice"](
        { invoiceId, expectedVersion },
        RpcBrowser.requestOptions(token),
      )),
    Effect.as({ text: "Invoice paid." }),
  ),
  failurePayload,
})

const loadCurrent = (model: Model, notice = model.notice) => {
  const token = Session.token(model.session)
  if (token === null || model.summary === null) return { model }
  return LoadOrder.start(model, { token, orderId: model.summary.order.id }, { notice })
}

export const update = (model: Model, message: Message): UpdateReturn => Message.match<UpdateReturn>(message, {
  SessionChanged: ({ message }) => {
    const child = Session.embed(model.session, message, (message) => Message.SessionChanged({ message }))
    const changed = Session.generationChanged(model.session, child.model)
    const next = changed
      ? RpcBrowser.reset(model, {
        session: child.model,
        summary: null,
        orderNumber: "",
        customer: "",
        lineNumber: "1",
        description: "",
        quantity: "1",
        unitAmountMinor: "",
        invoiceNumber: "",
        fieldErrors: {},
        notice: null,
      }).model
      : evo(model, { session: () => child.model })
    return { model: next, commands: child.commands }
  },
  ChangedOrderNumber: ({ value }) => ({ model: evo(model, { orderNumber: () => value, fieldErrors: () => ({}) }) }),
  ChangedCustomer: ({ value }) => ({ model: evo(model, { customer: () => value, fieldErrors: () => ({}) }) }),
  ChangedLineNumber: ({ value }) => ({ model: evo(model, { lineNumber: () => value, fieldErrors: () => ({}) }) }),
  ChangedDescription: ({ value }) => ({ model: evo(model, { description: () => value, fieldErrors: () => ({}) }) }),
  ChangedQuantity: ({ value }) => ({ model: evo(model, { quantity: () => value, fieldErrors: () => ({}) }) }),
  ChangedUnitAmountMinor: ({ value }) => ({ model: evo(model, { unitAmountMinor: () => value, fieldErrors: () => ({}) }) }),
  ChangedInvoiceNumber: ({ value }) => ({ model: evo(model, { invoiceNumber: () => value, fieldErrors: () => ({}) }) }),
  ClickedCreate: () => {
    const token = Session.token(model.session)
    if (token === null) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Sign in before creating an order." }) }) }
    return CreateOrder.start(model, { token, number: model.orderNumber, customer: model.customer }, {
      fieldErrors: {},
      notice: null,
    })
  },
  ClickedAddLine: () => {
    const token = Session.token(model.session)
    if (token === null || model.summary === null) return { model }
    return AddLine.start(model, { token, orderId: model.summary.order.id, expectedVersion: model.summary.order.version, lineNumber: model.lineNumber, description: model.description, quantity: model.quantity, unitAmountMinor: model.unitAmountMinor }, {
      fieldErrors: {},
      notice: null,
    })
  },
  ClickedIssue: () => {
    const token = Session.token(model.session)
    if (token === null || model.summary === null) return { model }
    return IssueInvoice.start(model, { token, orderId: model.summary.order.id, expectedVersion: model.summary.order.version, number: model.invoiceNumber }, {
      fieldErrors: {},
      notice: null,
    })
  },
  ClickedPay: () => {
    const token = Session.token(model.session)
    const invoice = model.summary?.invoice
    if (token === null || invoice === null || invoice === undefined) return { model }
    return PayInvoice.start(model, {
      token,
      invoiceId: invoice.id,
      expectedVersion: invoice.version,
    }, { notice: null })
  },
  ClickedReload: () => loadCurrent(model, null),
  SucceededCreate: ({ request, order }) => {
    const settled = RpcBrowser.succeed(model, request, {
      summary: null,
      orderNumber: "",
      customer: "",
      notice: { kind: "success" as const, text: "Order created." },
    })
    if (!settled.accepted) return { model }

    const token = Session.token(model.session)
    return token === null
      ? { model: settled.model }
      : LoadOrder.start(settled.model, { token, orderId: order.id })
  },
  SucceededSummary: ({ request, summary }) => RpcBrowser.succeed(model, request, {
    summary,
    lineNumber: String(summary.lines.length + 1),
    description: "",
    quantity: "1",
    unitAmountMinor: "",
  }),
  SucceededAction: ({ request, text }) => {
    const settled = RpcBrowser.succeed(model, request)
    return settled.accepted
      ? loadCurrent(settled.model, { kind: "success", text })
      : { model }
  },
  Failed: ({ request, error, fieldErrors }) => RpcBrowser.fail(model, request, error, {
    fieldErrors,
    notice: { kind: "error" as const, text: error },
  }),
})

export const init: Runtime.ApplicationInit<Model, Message, void, WebClient | SessionClient> = () => ({
  model: {
    session: Session.empty(), requests: Requests.empty(), summary: null,
    orderNumber: "", customer: "", lineNumber: "1", description: "", quantity: "1", unitAmountMinor: "", invoiceNumber: "",
    fieldErrors: {}, notice: { kind: "info", text: "Create an order, add lines, then issue and pay its invoice." },
  },
})
const money = (minor: number) => `$${(minor / 100).toFixed(2)}`
const fieldError = (h: HtmlBuilder<Message>, model: Model, name: string) =>
  model.fieldErrors[name] === undefined ? h.empty : h.p([h.Class("notice notice-error")], [model.fieldErrors[name]!])

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const summary = model.summary
  const invoice = summary?.invoice
  const isDraft = summary?.order.status === "draft"
  const pending = RpcBrowser.pending(model)
  return {
    title: "Orders and invoices",
    body: shell(h, {
      title: "Orders and invoices",
      lede: "Create a draft order, add priced lines, issue an invoice, and record payment with optimistic versions.",
      notice: model.notice,
      session: identitySessionView(h, model.session, (message) => Message.SessionChanged({ message })),
      children: [h.div([h.Class("split")], [
        h.section([h.Class("panel stack")], [
          h.div([h.Class("actions")], [h.h2([], ["Current order"]), quietButton(h, { label: pending ? "Loading…" : "Reload", message: Message.ClickedReload(), disabled: pending || summary === null })]),
          summary === null ? h.p([h.Class("empty")], ["No order selected. Create one to begin the billing flow."]) : h.div([h.Class("stack")], [
            dataTable(h, { caption: "Order summary", columns: ["Number", "Customer", "Status", "Total", "Version"], rows: [summary.order], key: (order) => order.id, cells: (order) => [order.number, order.customer, order.status, money(order.totalMinor), String(order.version)] }),
            dataTable(h, { caption: "Order lines", columns: ["#", "Description", "Quantity", "Unit amount", "Line total"], rows: summary.lines, key: (line) => line.id, cells: (line) => [String(line.lineNumber), line.description, String(line.quantity), money(line.unitAmountMinor), money(line.quantity * line.unitAmountMinor)] }),
            dataTable(h, { caption: "Invoice", columns: ["Number", "Status", "Total", "Version"], rows: invoice === null || invoice === undefined ? [] : [invoice], key: (item) => item.id, cells: (item) => [item.number, item.status, money(item.totalMinor), String(item.version)] }),
            invoice?.status === "issued" ? primaryButton(h, { label: "Record payment", message: Option.some(Message.ClickedPay()), type: "button", disabled: pending }) : h.empty,
          ]),
        ]),
        h.section([h.Class("panel stack")], [
          h.form([h.Class("stack"), h.OnSubmit(Message.ClickedCreate())], [
            h.h2([], ["1. Create order"]),
            field(h, { id: "order-number", label: "Order number", children: textInput(h, { id: "order-number", value: model.orderNumber, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedOrderNumber({ value }) }) }),
            field(h, { id: "customer", label: "Customer", children: textInput(h, { id: "customer", value: model.customer, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedCustomer({ value }) }) }),
            primaryButton(h, { label: "Create order", message: Option.none(), type: "submit", disabled: pending }),
          ]),
          h.form([h.Class("stack"), h.OnSubmit(Message.ClickedAddLine())], [
            h.h2([], ["2. Add line"]),
            h.div([h.Class("stack")], [
              field(h, { id: "line-number", label: "Line number", children: textInput(h, { id: "line-number", value: model.lineNumber, type: "number", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedLineNumber({ value }) }) }),
              fieldError(h, model, "lineNumber"),
            ]),
            field(h, { id: "description", label: "Description", children: textInput(h, { id: "description", value: model.description, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedDescription({ value }) }) }),
            h.div([h.Class("stack")], [
              field(h, { id: "quantity", label: "Quantity", children: textInput(h, { id: "quantity", value: model.quantity, type: "number", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedQuantity({ value }) }) }),
              fieldError(h, model, "quantity"),
            ]),
            h.div([h.Class("stack")], [
              field(h, { id: "unit-amount", label: "Unit amount (minor units)", children: textInput(h, { id: "unit-amount", value: model.unitAmountMinor, type: "number", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedUnitAmountMinor({ value }) }) }),
              fieldError(h, model, "unitAmountMinor"),
            ]),
            primaryButton(h, { label: "Add line", message: Option.none(), type: "submit", disabled: pending || !isDraft }),
          ]),
          h.form([h.Class("stack"), h.OnSubmit(Message.ClickedIssue())], [
            h.h2([], ["3. Issue invoice"]),
            field(h, { id: "invoice-number", label: "Invoice number", children: textInput(h, { id: "invoice-number", value: model.invoiceNumber, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedInvoiceNumber({ value }) }) }),
            primaryButton(h, { label: "Issue invoice", message: Option.none(), type: "submit", disabled: pending || !isDraft }),
          ]),
        ]),
      ])],
    }),
  }
}
