import { Effect, Equivalence, Option, Schema, pipe } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { ExampleRoles } from "@effect-domains/example-support/subject"
import { Operation } from "effect-domains/operation"
import { VersionConflict } from "effect-domains/repository-store"
import { Table } from "effect-domains/table"
import { OrderSummary } from "./contracts.ts"

import {
  AddLineInputSchema,
  BillingUnavailable,
  CreateOrderInputSchema,
  DuplicateInvoiceNumber,
  DuplicateOrderNumber,
  GetOrderInputSchema,
  InvoiceNotFound,
  InvoiceRequiresLines,
  InvoiceNumberSchema,
  IssueInvoiceInputSchema,
  OrderNotDraft,
  OrderNotFound,
  PayInvoiceInputSchema,
  TenantIdSchema,
  TotalOverflow,
} from "./domain.ts"

import {
  InvoiceTransitions,
  InvoicesResource,
  OrderLinesResource,
  OrdersResource,
  OrderTransitions,
} from "./resources.ts"

type SqliteRow = Readonly<Record<string, unknown>>

const OrderSummaryInputSchema = Schema.Struct({
  orderId: Schema.String,
  tenantId: TenantIdSchema,
})

const OrderProjection = Table.project(OrdersResource.table, [
  "id",
  "tenantId",
  "number",
  "customer",
  "status",
  "totalMinor",
  "version",
])

const OrderLineProjection = Table.project(OrderLinesResource.table, [
  "id",
  "tenantId",
  "orderId",
  "lineNumber",
  "description",
  "quantity",
  "unitAmountMinor",
])

const InvoiceProjection = Table.project(InvoicesResource.table, [
  "id",
  "tenantId",
  "orderId",
  "number",
  "status",
  "totalMinor",
  "version",
])

const OrderSummaryProjectionSchema = pipe(
  Schema.Struct({
    order: OrderProjection.json,
    lines: Schema.fromJsonString(Schema.Array(OrderLineProjection.schema)),
    invoice: Schema.NullOr(InvoiceProjection.json),
  }),
  Schema.decodeTo(OrderSummary),
)

const orderSummaryForTenant = SqlSchema.findOneOption({
  Request: OrderSummaryInputSchema,
  Result: OrderSummaryProjectionSchema,
  execute: Effect.fn("Billing.orderSummaryForTenant")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<SqliteRow>`
      SELECT ${OrderProjection.object(sql, "o")} AS ${sql("order")},
        COALESCE((
          SELECT json_group_array(${OrderLineProjection.object(sql, "l")})
          FROM (
            SELECT * FROM ${sql(OrderLinesResource.table.name)}
            WHERE ${sql("tenantId")} = o.${sql("tenantId")} AND ${sql("orderId")} = o.${sql("id")}
            ORDER BY ${sql("lineNumber")}
          ) l
        ), '[]') AS ${sql("lines")},
        (
          SELECT ${InvoiceProjection.object(sql, "i")}
          FROM ${sql(InvoicesResource.table.name)} i
          WHERE i.${sql("tenantId")} = o.${sql("tenantId")} AND i.${sql("orderId")} = o.${sql("id")}
          LIMIT 1
        ) AS ${sql("invoice")}
      FROM ${sql(OrdersResource.table.name)} o
      WHERE o.${sql("id")} = ${input.orderId} AND o.${sql("tenantId")} = ${input.tenantId}
      LIMIT 1
    `
  }),
})

const requireOrder = Effect.fn("Billing.requireOrder")(function* (orderId: string) {
  const order = yield* pipe(
    OrdersResource.repository.get(orderId),
    Effect.catchTag("ResourceNotFound", () => OrderNotFound.make({ orderId })),
  )

  const summary = yield* orderSummaryForTenant({ orderId, tenantId: order.tenantId })

  if (Option.isNone(summary)) return yield* OrderNotFound.make({ orderId })

  return summary.value
})

const requireInvoice = Effect.fn("Billing.requireInvoice")(function* (invoiceId: string) {
  return yield* pipe(
    InvoicesResource.repository.get(invoiceId),
    Effect.catchTag("ResourceNotFound", () => InvoiceNotFound.make({ invoiceId })),
  )
})

const noLines = Equivalence.strictEqual<number>()
const createOrderErrorSchema = Schema.Union([DuplicateOrderNumber, BillingUnavailable])
const addLineErrorSchema = Schema.Union([OrderNotFound, OrderNotDraft, TotalOverflow, VersionConflict, BillingUnavailable])

const issueInvoiceErrorSchema = Schema.Union([
  OrderNotFound,
  InvoiceRequiresLines,
  DuplicateInvoiceNumber,
  VersionConflict,
  OrderTransitions.Error,
  BillingUnavailable,
])

const payInvoiceErrorSchema = Schema.Union([InvoiceNotFound, VersionConflict, InvoiceTransitions.Error, BillingUnavailable])
const getOrderErrorSchema = Schema.Union([OrderNotFound, BillingUnavailable])

const createOrder = Operation.make({
  name: "billing.createOrder",
  payload: CreateOrderInputSchema,
  success: OrdersResource.table.rowSchema,
  error: createOrderErrorSchema,
  policy: ExampleRoles.editor,
  transaction: true,
  unavailable: BillingUnavailable,
  handler: Effect.fn("Billing.createOrder")(function* (input, subject) {
    const tenantId = TenantIdSchema.make(subject.tenantId)

    return yield* pipe(
      OrdersResource.repository.create({
        tenantId,
        number: input.number,
        customer: input.customer,
        status: "draft",
        totalMinor: 0,
      }),
      Effect.catchTag("UniqueViolation", () => DuplicateOrderNumber.make({ number: input.number })),
    )
  }),
})

const addLine = Operation.make({
  name: "billing.addLine",
  payload: AddLineInputSchema,
  success: OrderSummary,
  error: addLineErrorSchema,
  policy: ExampleRoles.editor,
  transaction: true,
  unavailable: BillingUnavailable,
  handler: Effect.fn("Billing.addLine")(function* (input) {
    const current = yield* requireOrder(input.orderId)

    if (current.order.status !== "draft") {
      return yield* OrderNotDraft.make({ orderId: input.orderId, actual: current.order.status })
    }

    const lineTotal = input.quantity * input.unitAmountMinor

    if (!Number.isSafeInteger(lineTotal)) return yield* TotalOverflow.make({ orderId: input.orderId })

    const totalMinor = current.order.totalMinor + lineTotal

    if (!Number.isSafeInteger(totalMinor)) return yield* TotalOverflow.make({ orderId: input.orderId })

    yield* OrdersResource.repository.patch(input.orderId, { totalMinor }, input.expectedVersion)

    yield* OrderLinesResource.repository.create({
      tenantId: current.order.tenantId,
      orderId: input.orderId,
      lineNumber: input.lineNumber,
      description: input.description,
      quantity: input.quantity,
      unitAmountMinor: input.unitAmountMinor,
    })

    return yield* requireOrder(input.orderId)
  }),
})

const issueInvoice = Operation.make({
  name: "billing.issueInvoice",
  payload: IssueInvoiceInputSchema,
  success: InvoicesResource.table.rowSchema,
  error: issueInvoiceErrorSchema,
  policy: ExampleRoles.editor,
  transaction: true,
  unavailable: BillingUnavailable,
  handler: Effect.fn("Billing.issueInvoice")(function* (input) {
    const current = yield* requireOrder(input.orderId)

    if (noLines(current.lines.length, 0)) {
      return yield* InvoiceRequiresLines.make({ orderId: input.orderId })
    }

    yield* OrdersResource.repository.transition(input.orderId, "issueInvoice", undefined, input.expectedVersion)

    return yield* pipe(
      InvoicesResource.repository.create({
        tenantId: current.order.tenantId,
        orderId: input.orderId,
        number: input.number,
        status: "issued",
        totalMinor: current.order.totalMinor,
      }),
      Effect.catchTag("UniqueViolation", () => DuplicateInvoiceNumber.make({ number: input.number })),
    )
  }),
})

const payInvoice = Operation.make({
  name: "billing.payInvoice",
  payload: PayInvoiceInputSchema,
  success: InvoicesResource.table.rowSchema,
  error: payInvoiceErrorSchema,
  policy: ExampleRoles.editor,
  transaction: true,
  unavailable: BillingUnavailable,
  handler: Effect.fn("Billing.payInvoice")(function* (input) {
    yield* requireInvoice(input.invoiceId)

    return yield* InvoicesResource.repository.transition(input.invoiceId, "pay", undefined, input.expectedVersion)
  }),
})

const getOrder = Operation.make({
  name: "billing.getOrder",
  payload: GetOrderInputSchema,
  success: OrderSummary,
  error: getOrderErrorSchema,
  policy: ExampleRoles.editor,
  transaction: true,
  unavailable: BillingUnavailable,
  handler: Effect.fn("Billing.getOrder")(function* (input) {
    return yield* requireOrder(input.orderId)
  }),
})

export const BillingOperations = Operation.bundle(createOrder, addLine, issueInvoice, payInvoice, getOrder)
