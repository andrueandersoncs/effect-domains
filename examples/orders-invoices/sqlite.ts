import { Effect, Equivalence, Option, Schema, pipe } from "effect"
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql"
import { ExampleRoles, ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { Command } from "effect-domains/command"
import { VersionConflict } from "effect-domains/repository-store"
import { Resource } from "effect-domains/resource"
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

const ordersTable = Resource.table(OrdersResource)
const orderLinesTable = Resource.table(OrderLinesResource)
const invoicesTable = Resource.table(InvoicesResource)

const OrderSummaryInputSchema = Schema.Struct({
  orderId: Schema.String,
  tenantId: TenantIdSchema,
})

const OrderProjection = Table.project(ordersTable, [
  "id",
  "tenantId",
  "number",
  "customer",
  "status",
  "totalMinor",
  "version",
])

const OrderLineProjection = Table.project(orderLinesTable, [
  "id",
  "tenantId",
  "orderId",
  "lineNumber",
  "description",
  "quantity",
  "unitAmountMinor",
])

const InvoiceProjection = Table.project(invoicesTable, [
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
            SELECT * FROM ${sql(orderLinesTable.name)}
            WHERE ${sql("tenantId")} = o.${sql("tenantId")} AND ${sql("orderId")} = o.${sql("id")}
            ORDER BY ${sql("lineNumber")}
          ) l
        ), '[]') AS ${sql("lines")},
        (
          SELECT ${InvoiceProjection.object(sql, "i")}
          FROM ${sql(invoicesTable.name)} i
          WHERE i.${sql("tenantId")} = o.${sql("tenantId")} AND i.${sql("orderId")} = o.${sql("id")}
          LIMIT 1
        ) AS ${sql("invoice")}
      FROM ${sql(ordersTable.name)} o
      WHERE o.${sql("id")} = ${input.orderId} AND o.${sql("tenantId")} = ${input.tenantId}
      LIMIT 1
    `
  }),
}) as (
  input: typeof OrderSummaryInputSchema.Type,
) => Effect.Effect<
  Option.Option<typeof OrderSummary.Type>,
  Schema.SchemaError | SqlError.SqlError,
  SqlClient.SqlClient
>

const requireOrder = Effect.fn("Billing.requireOrder")(function* (orderId: string) {
  const order = yield* pipe(
    Resource.repository(OrdersResource).get(orderId),
    Effect.catchTag("ResourceNotFound", () => OrderNotFound.make({ orderId })),
  )

  const summary = yield* orderSummaryForTenant({ orderId, tenantId: order.tenantId })

  if (Option.isNone(summary)) return yield* OrderNotFound.make({ orderId })

  return summary.value
})

const requireInvoice = Effect.fn("Billing.requireInvoice")(function* (invoiceId: string) {
  return yield* pipe(
    Resource.repository(InvoicesResource).get(invoiceId),
    Effect.catchTag("ResourceNotFound", () => InvoiceNotFound.make({ invoiceId })),
  )
})

const noLines = Equivalence.strictEqual<number>()
const addLineErrorSchema = Schema.Union([OrderNotFound, OrderNotDraft, TotalOverflow, VersionConflict])

const issueInvoiceErrorSchema = Schema.Union([
  OrderNotFound,
  InvoiceRequiresLines,
  DuplicateInvoiceNumber,
  VersionConflict,
  OrderTransitions.Error,
])

const payInvoiceErrorSchema = Schema.Union([InvoiceNotFound, VersionConflict, InvoiceTransitions.Error])

const BillingCommand = Command
  .family("billing.", BillingUnavailable)
  .authorized(ExampleRoles.editor)
  .transactional()

const createOrderSpec = BillingCommand.define({
  name: "createOrder",
  payload: CreateOrderInputSchema,
  success: ordersTable.rowSchema,
  errors: DuplicateOrderNumber,
  dependencies: [OrdersResource],
})

const createOrder = Command.implement(createOrderSpec, Effect.fn("Billing.createOrder")(function* (
  input: typeof CreateOrderInputSchema.Type,
  subject: typeof ExampleSubjectSchema.Type,
) {
  const tenantId = TenantIdSchema.make(subject.tenantId)

  return yield* pipe(
    Resource.repository(OrdersResource).create({
      tenantId,
      number: input.number,
      customer: input.customer,
      status: "draft",
      totalMinor: 0,
    }),
    Effect.catchTag("UniqueViolation", () => DuplicateOrderNumber.make({ number: input.number })),
  )
}))

const addLineSpec = BillingCommand.define({
  name: "addLine",
  payload: AddLineInputSchema,
  success: OrderSummary,
  errors: addLineErrorSchema,
  dependencies: [OrdersResource, OrderLinesResource, InvoicesResource],
})

const addLine = Command.implement(addLineSpec, Effect.fn("Billing.addLine")(function* (
  input: typeof AddLineInputSchema.Type,
) {
  const current = yield* requireOrder(input.orderId)

  if (current.order.status !== "draft") {
    return yield* OrderNotDraft.make({ orderId: input.orderId, actual: current.order.status })
  }

  const lineTotal = input.quantity * input.unitAmountMinor

  if (!Number.isSafeInteger(lineTotal)) return yield* TotalOverflow.make({ orderId: input.orderId })

  const totalMinor = current.order.totalMinor + lineTotal

  if (!Number.isSafeInteger(totalMinor)) return yield* TotalOverflow.make({ orderId: input.orderId })

  yield* Resource.repository(OrdersResource).patch(input.orderId, { totalMinor }, input.expectedVersion)

  yield* Resource.repository(OrderLinesResource).create({
    tenantId: current.order.tenantId,
    orderId: input.orderId,
    lineNumber: input.lineNumber,
    description: input.description,
    quantity: input.quantity,
    unitAmountMinor: input.unitAmountMinor,
  })

  return yield* requireOrder(input.orderId)
}))

const issueInvoiceSpec = BillingCommand.define({
  name: "issueInvoice",
  payload: IssueInvoiceInputSchema,
  success: invoicesTable.rowSchema,
  errors: issueInvoiceErrorSchema,
  dependencies: [OrdersResource, OrderLinesResource, InvoicesResource],
})

const issueInvoice = Command.implement(issueInvoiceSpec, Effect.fn("Billing.issueInvoice")(function* (
  input: typeof IssueInvoiceInputSchema.Type,
) {
  const current = yield* requireOrder(input.orderId)

  if (noLines(current.lines.length, 0)) {
    return yield* InvoiceRequiresLines.make({ orderId: input.orderId })
  }

  yield* Resource.repository(OrdersResource).transition(
    input.orderId,
    "issueInvoice",
    undefined,
    input.expectedVersion,
  )

  return yield* pipe(
    Resource.repository(InvoicesResource).create({
      tenantId: current.order.tenantId,
      orderId: input.orderId,
      number: input.number,
      status: "issued",
      totalMinor: current.order.totalMinor,
    }),
    Effect.catchTag("UniqueViolation", () => DuplicateInvoiceNumber.make({ number: input.number })),
  )
}))

const payInvoiceSpec = BillingCommand.define({
  name: "payInvoice",
  payload: PayInvoiceInputSchema,
  success: invoicesTable.rowSchema,
  errors: payInvoiceErrorSchema,
  dependencies: [InvoicesResource],
})

const payInvoice = Command.implement(payInvoiceSpec, Effect.fn("Billing.payInvoice")(function* (
  input: typeof PayInvoiceInputSchema.Type,
) {
  yield* requireInvoice(input.invoiceId)

  return yield* Resource.repository(InvoicesResource).transition(
    input.invoiceId,
    "pay",
    undefined,
    input.expectedVersion,
  )
}))

const getOrderSpec = BillingCommand.define({
  name: "getOrder",
  payload: GetOrderInputSchema,
  success: OrderSummary,
  errors: OrderNotFound,
  dependencies: [OrdersResource, OrderLinesResource, InvoicesResource],
})

const getOrder = Command.implement(getOrderSpec, Effect.fn("Billing.getOrder")(function* (
  input: typeof GetOrderInputSchema.Type,
) {
  return yield* requireOrder(input.orderId)
}))

const BillingOperations = Command.bundle(
  createOrder,
  addLine,
  issueInvoice,
  payInvoice,
  getOrder,
)

export { BillingOperations }
