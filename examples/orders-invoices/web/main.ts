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
  shell,
  textInput,
} from "@effect-domains/example-web/html"
import { rpcCall } from "@effect-domains/example-web/rpc"

const OrderSchema = Schema.Struct({
  id: Schema.String,
  tenantId: Schema.String,
  number: Schema.String,
  customer: Schema.String,
  status: Schema.Literals(["draft", "invoiced"]),
  totalMinor: Schema.Int,
  version: Schema.Int,
})

const OrderLineSchema = Schema.Struct({
  id: Schema.String,
  tenantId: Schema.String,
  orderId: Schema.String,
  lineNumber: Schema.Int,
  description: Schema.String,
  quantity: Schema.Int,
  unitAmountMinor: Schema.Int,
})

const InvoiceSchema = Schema.Struct({
  id: Schema.String,
  tenantId: Schema.String,
  orderId: Schema.String,
  number: Schema.String,
  status: Schema.Literals(["issued", "paid"]),
  totalMinor: Schema.Int,
  version: Schema.Int,
})

const OrderSummarySchema = Schema.Struct({
  order: OrderSchema,
  lines: Schema.Array(OrderLineSchema),
  invoice: Schema.NullOr(InvoiceSchema),
})

type OrderSummary = typeof OrderSummarySchema.Type

export const Model = Schema.Struct({
  token: Schema.String,
  sessionGeneration: Schema.Int,
  summary: Schema.NullOr(OrderSummarySchema),
  orderNumber: Schema.String,
  customer: Schema.String,
  lineNumber: Schema.String,
  description: Schema.String,
  quantity: Schema.String,
  unitAmountMinor: Schema.String,
  invoiceNumber: Schema.String,
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
  SucceededCreate: { generation: Schema.Int, order: OrderSchema },
  SucceededSummary: { generation: Schema.Int, summary: OrderSummarySchema },
  SucceededAction: { generation: Schema.Int, text: Schema.String },
  Failed: { generation: Schema.Int, error: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message>

const asPositiveInteger = (value: string) => Number.parseInt(value, 10)

const describeError = (error: string) =>
  error.includes("VersionConflict")
    ? "Version conflict: this order or invoice changed. Reload it and try again."
    : error

export const LoadOrder = Command.define("LoadOrder", {
  args: { token: Schema.String, generation: Schema.Int, orderId: Schema.String },
  messages: [Message.SucceededSummary, Message.Failed],
  execute: ({ token, generation, orderId }) => pipe(
    rpcCall({
      tag: "billing.getOrder",
      payload: { orderId },
      token,
      success: OrderSummarySchema,
    }),
    Effect.match({
      onSuccess: (summary) => Message.SucceededSummary({ generation, summary }),
      onFailure: (error) => Message.Failed({ generation, error: describeError(error.message) }),
    }),
  ),
})

export const CreateOrder = Command.define("CreateOrder", {
  args: { token: Schema.String, generation: Schema.Int, number: Schema.String, customer: Schema.String },
  messages: [Message.SucceededCreate, Message.Failed],
  execute: ({ token, generation, number, customer }) => pipe(
    rpcCall({
      tag: "billing.createOrder",
      payload: { number: number.trim(), customer: customer.trim() },
      token,
      success: OrderSchema,
    }),
    Effect.match({
      onSuccess: (order) => Message.SucceededCreate({ generation, order }),
      onFailure: (error) => Message.Failed({ generation, error: describeError(error.message) }),
    }),
  ),
})

export const AddLine = Command.define("AddLine", {
  args: {
    token: Schema.String,
    generation: Schema.Int,
    orderId: Schema.String,
    expectedVersion: Schema.Int,
    lineNumber: Schema.String,
    description: Schema.String,
    quantity: Schema.String,
    unitAmountMinor: Schema.String,
  },
  messages: [Message.SucceededSummary, Message.Failed],
  execute: (args) => pipe(
    rpcCall({
      tag: "billing.addLine",
      payload: {
        orderId: args.orderId,
        expectedVersion: args.expectedVersion,
        lineNumber: asPositiveInteger(args.lineNumber),
        description: args.description.trim(),
        quantity: asPositiveInteger(args.quantity),
        unitAmountMinor: asPositiveInteger(args.unitAmountMinor),
      },
      token: args.token,
      success: OrderSummarySchema,
    }),
    Effect.match({
      onSuccess: (summary) => Message.SucceededSummary({ generation: args.generation, summary }),
      onFailure: (error) => Message.Failed({ generation: args.generation, error: describeError(error.message) }),
    }),
  ),
})

export const IssueInvoice = Command.define("IssueInvoice", {
  args: { token: Schema.String, generation: Schema.Int, orderId: Schema.String, expectedVersion: Schema.Int, number: Schema.String },
  messages: [Message.SucceededAction, Message.Failed],
  execute: ({ token, generation, orderId, expectedVersion, number }) => pipe(
    rpcCall({
      tag: "billing.issueInvoice",
      payload: { orderId, expectedVersion, number: number.trim() },
      token,
      success: InvoiceSchema,
    }),
    Effect.match({
      onSuccess: () => Message.SucceededAction({ generation, text: "Invoice issued." }),
      onFailure: (error) => Message.Failed({ generation, error: describeError(error.message) }),
    }),
  ),
})

export const PayInvoice = Command.define("PayInvoice", {
  args: { token: Schema.String, generation: Schema.Int, invoiceId: Schema.String, expectedVersion: Schema.Int },
  messages: [Message.SucceededAction, Message.Failed],
  execute: ({ token, generation, invoiceId, expectedVersion }) => pipe(
    rpcCall({
      tag: "billing.payInvoice",
      payload: { invoiceId, expectedVersion },
      token,
      success: InvoiceSchema,
    }),
    Effect.match({
      onSuccess: () => Message.SucceededAction({ generation, text: "Invoice paid." }),
      onFailure: (error) => Message.Failed({ generation, error: describeError(error.message) }),
    }),
  ),
})

const loadCurrentOrder = (model: Model) =>
  model.summary === null ? [] : [LoadOrder({
    token: model.token,
    generation: model.sessionGeneration,
    orderId: model.summary.order.id,
  })]

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedToken: ({ value }) => ({
      model: evo(model, {
        token: () => value,
        sessionGeneration: (generation) => generation + 1,
        summary: () => null,
        busy: () => false,
        notice: () => null,
      }),
    }),
    SelectedToken: ({ token }) => ({
      model: evo(model, {
        token: () => token,
        sessionGeneration: (generation) => generation + 1,
        summary: () => null,
        busy: () => false,
        notice: () => null,
      }),
    }),
    ChangedOrderNumber: ({ value }) => ({ model: evo(model, { orderNumber: () => value }) }),
    ChangedCustomer: ({ value }) => ({ model: evo(model, { customer: () => value }) }),
    ChangedLineNumber: ({ value }) => ({ model: evo(model, { lineNumber: () => value }) }),
    ChangedDescription: ({ value }) => ({ model: evo(model, { description: () => value }) }),
    ChangedQuantity: ({ value }) => ({ model: evo(model, { quantity: () => value }) }),
    ChangedUnitAmountMinor: ({ value }) => ({ model: evo(model, { unitAmountMinor: () => value }) }),
    ChangedInvoiceNumber: ({ value }) => ({ model: evo(model, { invoiceNumber: () => value }) }),
    ClickedCreate: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [CreateOrder({
        token: model.token,
        generation: model.sessionGeneration,
        number: model.orderNumber,
        customer: model.customer,
      })],
    }),
    ClickedAddLine: () => {
      if (model.summary === null) return { model }
      return {
        model: evo(model, { busy: () => true, notice: () => null }),
        commands: [AddLine({
          token: model.token,
          generation: model.sessionGeneration,
          orderId: model.summary.order.id,
          expectedVersion: model.summary.order.version,
          lineNumber: model.lineNumber,
          description: model.description,
          quantity: model.quantity,
          unitAmountMinor: model.unitAmountMinor,
        })],
      }
    },
    ClickedIssue: () => {
      if (model.summary === null) return { model }
      return {
        model: evo(model, { busy: () => true, notice: () => null }),
        commands: [IssueInvoice({
          token: model.token,
          generation: model.sessionGeneration,
          orderId: model.summary.order.id,
          expectedVersion: model.summary.order.version,
          number: model.invoiceNumber,
        })],
      }
    },
    ClickedPay: () => {
      const invoice = model.summary?.invoice
      if (invoice === null || invoice === undefined) return { model }
      return {
        model: evo(model, { busy: () => true, notice: () => null }),
        commands: [PayInvoice({
          token: model.token,
          generation: model.sessionGeneration,
          invoiceId: invoice.id,
          expectedVersion: invoice.version,
        })],
      }
    },
    ClickedReload: () => ({
      model: evo(model, { busy: () => model.summary !== null, notice: () => null }),
      commands: loadCurrentOrder(model),
    }),
    SucceededCreate: ({ generation, order }) => {
      if (generation !== model.sessionGeneration) return { model }
      return {
        model: evo(model, {
          busy: () => true,
          orderNumber: () => "",
          customer: () => "",
          notice: () => ({ kind: "success" as const, text: "Order created." }),
        }),
        commands: [LoadOrder({ token: model.token, generation, orderId: order.id })],
      }
    },
    SucceededSummary: ({ generation, summary }) => {
      if (generation !== model.sessionGeneration) return { model }
      return {
        model: evo(model, {
          summary: () => summary,
          lineNumber: () => String(summary.lines.length + 1),
          description: () => "",
          quantity: () => "1",
          unitAmountMinor: () => "",
          busy: () => false,
        }),
      }
    },
    SucceededAction: ({ generation, text }) => {
      if (generation !== model.sessionGeneration) return { model }
      return {
        model: evo(model, { busy: () => true, notice: () => ({ kind: "success" as const, text }) }),
        commands: loadCurrentOrder(model),
      }
    },
    Failed: ({ generation, error }) => {
      if (generation !== model.sessionGeneration) return { model }
      return {
        model: evo(model, { busy: () => false, notice: () => ({ kind: "error" as const, text: error }) }),
      }
    },
  })

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    token: "alice-demo",
    sessionGeneration: 0,
    summary: null,
    orderNumber: "",
    customer: "",
    lineNumber: "1",
    description: "",
    quantity: "1",
    unitAmountMinor: "",
    invoiceNumber: "",
    busy: false,
    notice: { kind: "info", text: "Create an order, add lines, then issue and pay its invoice." },
  },
})

const money = (minor: number) => `$${(minor / 100).toFixed(2)}`

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const summary = model.summary
  const invoice = summary?.invoice
  const canMutate = model.token !== "bob-demo"
  const isDraft = summary?.order.status === "draft"

  return {
    title: "Orders and invoices",
    body: shell(h, {
      title: "Orders and invoices",
      lede: "Create a draft order, add priced lines, issue an invoice, and record payment with optimistic versions.",
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
                h.div([h.Class("actions")], [
                  h.h2([], ["Current order"]),
                  quietButton(h, {
                    label: model.busy ? "Loading…" : "Reload",
                    message: Message.ClickedReload(),
                    disabled: model.busy || summary === null,
                  }),
                ]),
                summary === null
                  ? h.p([h.Class("empty")], ["No order selected. Create one to begin the billing flow."])
                  : h.div([h.Class("stack")], [
                    dataTable(h, {
                      caption: "Order summary",
                      columns: ["Number", "Customer", "Status", "Total", "Version"],
                      rows: [summary.order],
                      key: (order) => order.id,
                      cells: (order) => [order.number, order.customer, order.status, money(order.totalMinor), String(order.version)],
                    }),
                    dataTable(h, {
                      caption: "Order lines",
                      columns: ["#", "Description", "Quantity", "Unit amount", "Line total"],
                      rows: summary.lines,
                      key: (line) => line.id,
                      cells: (line) => [
                        String(line.lineNumber),
                        line.description,
                        String(line.quantity),
                        money(line.unitAmountMinor),
                        money(line.quantity * line.unitAmountMinor),
                      ],
                    }),
                    dataTable(h, {
                      caption: "Invoice",
                      columns: ["Number", "Status", "Total", "Version"],
                      rows: invoice === null || invoice === undefined ? [] : [invoice],
                      key: (item) => item.id,
                      cells: (item) => [item.number, item.status, money(item.totalMinor), String(item.version)],
                    }),
                    invoice?.status === "issued"
                      ? primaryButton(h, {
                        label: "Record payment",
                        message: Option.some(Message.ClickedPay()),
                        type: "button",
                        disabled: model.busy || !canMutate,
                      })
                      : h.empty,
                  ]),
              ],
            ),
            h.section(
              [h.Class("panel stack")],
              [
                h.form(
                  [h.Class("stack"), h.OnSubmit(Message.ClickedCreate())],
                  [
                    h.h2([], ["1. Create order"]),
                    field(h, {
                      id: "order-number",
                      label: "Order number",
                      children: textInput(h, { id: "order-number", value: model.orderNumber, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedOrderNumber({ value }) }),
                    }),
                    field(h, {
                      id: "customer",
                      label: "Customer",
                      children: textInput(h, { id: "customer", value: model.customer, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedCustomer({ value }) }),
                    }),
                    primaryButton(h, { label: "Create order", message: Option.none(), type: "submit", disabled: model.busy || !canMutate }),
                  ],
                ),
                h.form(
                  [h.Class("stack"), h.OnSubmit(Message.ClickedAddLine())],
                  [
                    h.h2([], ["2. Add line"]),
                    field(h, {
                      id: "line-number",
                      label: "Line number",
                      children: textInput(h, { id: "line-number", value: model.lineNumber, type: "number", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedLineNumber({ value }) }),
                    }),
                    field(h, {
                      id: "description",
                      label: "Description",
                      children: textInput(h, { id: "description", value: model.description, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedDescription({ value }) }),
                    }),
                    field(h, {
                      id: "quantity",
                      label: "Quantity",
                      children: textInput(h, { id: "quantity", value: model.quantity, type: "number", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedQuantity({ value }) }),
                    }),
                    field(h, {
                      id: "unit-amount",
                      label: "Unit amount (minor units)",
                      children: textInput(h, { id: "unit-amount", value: model.unitAmountMinor, type: "number", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedUnitAmountMinor({ value }) }),
                    }),
                    primaryButton(h, { label: "Add line", message: Option.none(), type: "submit", disabled: model.busy || !canMutate || !isDraft }),
                  ],
                ),
                h.form(
                  [h.Class("stack"), h.OnSubmit(Message.ClickedIssue())],
                  [
                    h.h2([], ["3. Issue invoice"]),
                    field(h, {
                      id: "invoice-number",
                      label: "Invoice number",
                      children: textInput(h, { id: "invoice-number", value: model.invoiceNumber, type: "text", placeholder: "", autocomplete: "off", onInput: (value) => Message.ChangedInvoiceNumber({ value }) }),
                    }),
                    primaryButton(h, { label: "Issue invoice", message: Option.none(), type: "submit", disabled: model.busy || !canMutate || !isDraft }),
                  ],
                ),
              ],
            ),
          ],
        ),
      ],
    }),
  }
}
