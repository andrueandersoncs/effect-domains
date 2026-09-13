import { Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import { dataTable, field, primaryButton, quietButton, shell, textInput } from "@effect-domains/example-web/html"
import { BrowserModel } from "effect-domains/browser-model"
import { Form } from "effect-domains/form"
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
const OrderSchema = OrdersResource.table.rowSchema

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
  InvalidLine: { request: RequestTokenSchema, errors: BrowserModel.FieldErrorsSchema },
  Failed: { request: RequestTokenSchema, error: Schema.String },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient | SessionClient>

export const LoadOrder = Command.define("LoadOrder", {
  args: { request: RequestTokenSchema, token: Schema.String, orderId: Schema.String },
  messages: [Message.SucceededSummary, Message.Failed],
  execute: ({ request, token, orderId }) => pipe(
    Effect.gen(function*() {
      const client = yield* WebClient
      return yield* client["billing.getOrder"]({ orderId }, RpcBrowser.requestOptions(token))
    }),
    Effect.match({
      onSuccess: (summary) => Message.SucceededSummary({ request, summary }),
      onFailure: (error) => Message.Failed({ request, error: errorText(error) }),
    }),
  ),
})
export const CreateOrder = Command.define("CreateOrder", {
  args: { request: RequestTokenSchema, token: Schema.String, number: Schema.String, customer: Schema.String },
  messages: [Message.SucceededCreate, Message.Failed],
  execute: ({ request, token, number, customer }) => pipe(
    Schema.decodeUnknownEffect(CreateOrderInputSchema)({ number: number.trim(), customer: customer.trim() }),
    Effect.flatMap((input) => Effect.gen(function*() {
      const client = yield* WebClient
      return yield* client["billing.createOrder"](input, RpcBrowser.requestOptions(token))
    })),
    Effect.match({
      onSuccess: (order) => Message.SucceededCreate({ request, order }),
      onFailure: (error) => Message.Failed({ request, error: errorText(error) }),
    }),
  ),
})
export const AddLine = Command.define("AddLine", {
  args: { request: RequestTokenSchema, token: Schema.String, orderId: Schema.String, expectedVersion: Schema.Int, lineNumber: Schema.String, description: Schema.String, quantity: Schema.String, unitAmountMinor: Schema.String },
  messages: [Message.SucceededSummary, Message.InvalidLine, Message.Failed],
  execute: (args) => pipe(
    Schema.decodeUnknownEffect(integerFields)({
      lineNumber: args.lineNumber,
      quantity: args.quantity,
      unitAmountMinor: args.unitAmountMinor,
    }),
    Effect.matchEffect({
      onFailure: (error) => Effect.succeed(Message.InvalidLine({ request: args.request, errors: Form.errors(error) })),
      onSuccess: (numbers) => pipe(
        Effect.gen(function*() {
          const client = yield* WebClient
          return yield* client["billing.addLine"]({
            orderId: args.orderId,
            expectedVersion: args.expectedVersion,
            lineNumber: numbers.lineNumber,
            description: args.description.trim(),
            quantity: numbers.quantity,
            unitAmountMinor: numbers.unitAmountMinor,
          }, RpcBrowser.requestOptions(args.token))
        }),
        Effect.match({
          onSuccess: (summary) => Message.SucceededSummary({ request: args.request, summary }),
          onFailure: (error) => Message.Failed({ request: args.request, error: errorText(error) }),
        }),
      ),
    }),
  ),
})
export const IssueInvoice = Command.define("IssueInvoice", {
  args: { request: RequestTokenSchema, token: Schema.String, orderId: Schema.String, expectedVersion: Schema.Int, number: Schema.String },
  messages: [Message.SucceededAction, Message.Failed],
  execute: ({ request, token, orderId, expectedVersion, number }) => pipe(
    Schema.decodeUnknownEffect(InvoiceNumberSchema)(number.trim()),
    Effect.flatMap((number) => Effect.gen(function*() {
      const client = yield* WebClient
      yield* client["billing.issueInvoice"]({ orderId, expectedVersion, number }, RpcBrowser.requestOptions(token))
    })),
    Effect.match({
      onSuccess: () => Message.SucceededAction({ request, text: "Invoice issued." }),
      onFailure: (error) => Message.Failed({ request, error: errorText(error) }),
    }),
  ),
})
export const PayInvoice = Command.define("PayInvoice", {
  args: { request: RequestTokenSchema, token: Schema.String, invoiceId: Schema.String, expectedVersion: Schema.Int },
  messages: [Message.SucceededAction, Message.Failed],
  execute: ({ request, token, invoiceId, expectedVersion }) => pipe(
    Effect.gen(function*() {
      const client = yield* WebClient
      yield* client["billing.payInvoice"]({ invoiceId, expectedVersion }, RpcBrowser.requestOptions(token))
    }),
    Effect.match({
      onSuccess: () => Message.SucceededAction({ request, text: "Invoice paid." }),
      onFailure: (error) => Message.Failed({ request, error: errorText(error) }),
    }),
  ),
})

const start = (model: Model, key: string) => Requests.start(model.requests, key)
const loadCurrent = (model: Model, notice = model.notice) => {
  const token = Session.token(model.session)
  if (token === null || model.summary === null) return { model }
  const started = start(model, "billing.load")
  return {
    model: evo(model, { requests: () => started.state, notice: () => notice }),
    commands: [LoadOrder({ request: started.request, token, orderId: model.summary.order.id })],
  }
}

export const update = (model: Model, message: Message): UpdateReturn => Message.match<UpdateReturn>(message, {
  SessionChanged: ({ message }) => {
    const child = Session.embed(model.session, message, (message) => Message.SessionChanged({ message }))
    const changed = Session.generationChanged(model.session, child.model)
    const next = changed
      ? evo(model, {
        session: () => child.model,
        requests: () => Requests.reset(model.requests),
        summary: () => null,
        orderNumber: () => "",
        customer: () => "",
        lineNumber: () => "1",
        description: () => "",
        quantity: () => "1",
        unitAmountMinor: () => "",
        invoiceNumber: () => "",
        fieldErrors: BrowserModel.emptyFieldErrors,
        notice: () => null,
      })
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
    const started = start(model, "billing.create")
    return { model: evo(model, { requests: () => started.state, fieldErrors: () => ({}), notice: () => null }), commands: [CreateOrder({ request: started.request, token, number: model.orderNumber, customer: model.customer })] }
  },
  ClickedAddLine: () => {
    const token = Session.token(model.session)
    if (token === null || model.summary === null) return { model }
    const started = start(model, "billing.addLine")
    return { model: evo(model, { requests: () => started.state, fieldErrors: () => ({}), notice: () => null }), commands: [AddLine({ request: started.request, token, orderId: model.summary.order.id, expectedVersion: model.summary.order.version, lineNumber: model.lineNumber, description: model.description, quantity: model.quantity, unitAmountMinor: model.unitAmountMinor })] }
  },
  ClickedIssue: () => {
    const token = Session.token(model.session)
    if (token === null || model.summary === null) return { model }
    const started = start(model, "billing.issue")
    return { model: evo(model, { requests: () => started.state, fieldErrors: () => ({}), notice: () => null }), commands: [IssueInvoice({ request: started.request, token, orderId: model.summary.order.id, expectedVersion: model.summary.order.version, number: model.invoiceNumber })] }
  },
  ClickedPay: () => {
    const token = Session.token(model.session)
    const invoice = model.summary?.invoice
    if (token === null || invoice === null || invoice === undefined) return { model }
    const started = start(model, "billing.pay")
    return {
      model: evo(model, { requests: () => started.state, notice: () => null }),
      commands: [PayInvoice({ request: started.request, token, invoiceId: invoice.id, expectedVersion: invoice.version })],
    }
  },
  ClickedReload: () => loadCurrent(model, null),
  SucceededCreate: ({ request, order }) => {
    if (!Requests.accepts(model.requests, request)) return { model }
    const afterCreate = Requests.succeed(model.requests, request)
    const token = Session.token(model.session)
    if (token === null) return { model: evo(model, { requests: () => afterCreate }) }
    const started = Requests.start(afterCreate, "billing.load")
    return {
      model: evo(model, {
        requests: () => started.state,
        summary: () => null,
        orderNumber: () => "",
        customer: () => "",
        notice: () => ({ kind: "success" as const, text: "Order created." }),
      }),
      commands: [LoadOrder({ request: started.request, token, orderId: order.id })],
    }
  },
  SucceededSummary: ({ request, summary }) => !Requests.accepts(model.requests, request) ? { model } : {
    model: evo(model, { requests: () => Requests.succeed(model.requests, request), summary: () => summary, lineNumber: () => String(summary.lines.length + 1), description: () => "", quantity: () => "1", unitAmountMinor: () => "" }),
  },
  SucceededAction: ({ request, text }) => {
    if (!Requests.accepts(model.requests, request)) return { model }
    return loadCurrent(evo(model, { requests: () => Requests.succeed(model.requests, request) }), { kind: "success", text })
  },
  InvalidLine: ({ request, errors }) => !Requests.accepts(model.requests, request) ? { model } : {
    model: evo(model, { requests: () => Requests.succeed(model.requests, request), fieldErrors: () => errors, notice: () => ({ kind: "error" as const, text: "Correct the highlighted line fields." }) }),
  },
  Failed: ({ request, error }) => !Requests.accepts(model.requests, request) ? { model } : {
    model: evo(model, { requests: () => Requests.fail(model.requests, request, error), notice: () => ({ kind: "error" as const, text: error }) }),
  },
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
  const pending = Requests.pending(model.requests)
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
