import { Schema } from "effect"
import { RpcGroup } from "effect/unstable/rpc"
import { Forbidden } from "effect-domains/authorization"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { Commands } from "effect-domains/commands"

import {
  AddLineInputSchema,
  BillingUnavailable,
  CreateOrderInputSchema,
  DuplicateInvoiceNumber,
  DuplicateOrderNumber,
  GetOrderInputSchema,
  InvalidInvoiceTransition,
  InvalidOrderTransition,
  InvoiceNotFound,
  InvoiceRequiresLines,
  IssueInvoiceInputSchema,
  OrderNotFound,
  PayInvoiceInputSchema,
  TotalOverflow,
  VersionConflict,
} from "./domain.ts"

import { InvoicesResource, OrderLinesResource, OrdersResource } from "./resources.ts"

const OrderSummaryLinesSchema = Schema.Array(OrderLinesResource.table.rowSchema)
const OrderSummaryInvoiceSchema = Schema.NullOr(InvoicesResource.table.rowSchema)

export class OrderSummary extends Schema.Class<OrderSummary>("OrderSummary")({
  order: OrdersResource.table.rowSchema,
  lines: OrderSummaryLinesSchema,
  invoice: OrderSummaryInvoiceSchema,
}) {}

const createOrderErrorsSchema = Schema.Union([Forbidden, DuplicateOrderNumber, BillingUnavailable])

const addLineErrorsSchema = Schema.Union([
  Forbidden,
  OrderNotFound,
  InvalidOrderTransition,
  VersionConflict,
  TotalOverflow,
  BillingUnavailable,
])

const issueInvoiceErrorsSchema = Schema.Union([
  Forbidden,
  OrderNotFound,
  InvalidOrderTransition,
  InvoiceRequiresLines,
  VersionConflict,
  DuplicateInvoiceNumber,
  BillingUnavailable,
])

const payInvoiceErrorsSchema = Schema.Union([
  Forbidden,
  InvoiceNotFound,
  InvalidInvoiceTransition,
  VersionConflict,
  BillingUnavailable,
])

const getOrderErrorsSchema = Schema.Union([Forbidden, OrderNotFound, BillingUnavailable])

const createOrder = Commands.rpc("billing.createOrder", {
  payload: CreateOrderInputSchema,
  success: OrdersResource.table.rowSchema,
  error: createOrderErrorsSchema,
}).middleware(AuthorizationRpc)

const addLine = Commands.rpc("billing.addLine", {
  payload: AddLineInputSchema,
  success: OrderSummary,
  error: addLineErrorsSchema,
}).middleware(AuthorizationRpc)

const issueInvoice = Commands.rpc("billing.issueInvoice", {
  payload: IssueInvoiceInputSchema,
  success: InvoicesResource.table.rowSchema,
  error: issueInvoiceErrorsSchema,
}).middleware(AuthorizationRpc)

const payInvoice = Commands.rpc("billing.payInvoice", {
  payload: PayInvoiceInputSchema,
  success: InvoicesResource.table.rowSchema,
  error: payInvoiceErrorsSchema,
}).middleware(AuthorizationRpc)

const getOrder = Commands.rpc("billing.getOrder", {
  payload: GetOrderInputSchema,
  success: OrderSummary,
  error: getOrderErrorsSchema,
}).middleware(AuthorizationRpc)

const billingRpcs = RpcGroup.make(createOrder, addLine, issueInvoice, payInvoice, getOrder)

export const Billing = Commands.make({
  name: "apps/orders-invoices/Billing",
  group: billingRpcs,
})
