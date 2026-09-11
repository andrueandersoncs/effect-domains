import { Array, Effect, Function, Match, Option, Schema, pipe } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { Authorization } from "effect-domains/authorization"
import { BillingRpcs, OrderSummary } from "./contracts.ts"

import {
  type AddLineInput,
  AddLineInputSchema,
  type CreateOrderInput,
  CreateOrderInputSchema,
  type GetOrderInput,
  type IssueInvoiceInput,
  IssueInvoiceInputSchema,
  type PayInvoiceInput,
  PayInvoiceInputSchema,
  BillingUnavailable,
  DuplicateInvoiceNumber,
  DuplicateOrderNumber,
  InvalidInvoiceTransition,
  InvalidOrderTransition,
  InvoiceNotFound,
  InvoiceRequiresLines,
  InvoiceSchema,
  MinorUnitsSchema,
  OrderNotFound,
  OrderSchema,
  OrderLineSchema,
  TenantIdSchema,
  TotalOverflow,
  VersionConflict,
} from "./domain.ts"

import { BillingReadAuthorization, BillingWriteAuthorization, InvoicesResource, OrderLinesResource, OrdersResource } from "./resources.ts"
import { NestedRow } from "./projection.ts"
type SqliteRow = Readonly<Record<string, unknown>>

const ScopedOrderInputSchema = Schema.Struct({
  orderId: Schema.String,
  tenantId: TenantIdSchema,
})

const ScopedInvoiceInputSchema = Schema.Struct({
  invoiceId: Schema.String,
  tenantId: TenantIdSchema,
})

const CreateOrderRecordSchema = Schema.Struct({
  ...CreateOrderInputSchema.fields,
  tenantId: TenantIdSchema,
})

const TenantOrderNumberInputSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  number: CreateOrderInputSchema.fields.number,
})

const TenantInvoiceNumberInputSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  number: IssueInvoiceInputSchema.fields.number,
})

const AddLineRecordSchema = Schema.Struct({
  ...AddLineInputSchema.fields,
  tenantId: TenantIdSchema,
  totalMinor: MinorUnitsSchema,
})

const IssueInvoiceRecordSchema = Schema.Struct({
  ...IssueInvoiceInputSchema.fields,
  tenantId: TenantIdSchema,
  totalMinor: MinorUnitsSchema,
})

const PayInvoiceRecordSchema = Schema.Struct({
  ...PayInvoiceInputSchema.fields,
  tenantId: TenantIdSchema,
})

const OrderProjection = NestedRow.make({ table: OrdersResource.table, fields: [
  "id",
  "tenantId",
  "number",
  "customer",
  "status",
  "totalMinor",
  "version",
] as const })

const OrderLineProjection = NestedRow.make({ table: OrderLinesResource.table, fields: [
  "id",
  "tenantId",
  "orderId",
  "lineNumber",
  "description",
  "quantity",
  "unitAmountMinor",
] as const })

const InvoiceProjection = NestedRow.make({ table: InvoicesResource.table, fields: [
  "id",
  "tenantId",
  "orderId",
  "number",
  "status",
  "totalMinor",
  "version",
] as const })

const OrderSummaryProjectionSchema = pipe(
  Schema.Struct({
    order: OrderProjection.json,
    lines: Schema.fromJsonString(Schema.Array(OrderLineProjection.schema)),
    invoice: Schema.NullOr(InvoiceProjection.json),
  }),
  Schema.decodeTo(OrderSummary),
)

const IdRowSchema = Schema.Struct({ id: Schema.String })
// Use encoded constructors because SqlSchema encodes request fields before execute.
const OrderInsertSchema = Schema.toEncoded(OrderSchema)
const OrderLineInsertSchema = Schema.toEncoded(OrderLineSchema)
const InvoiceInsertSchema = Schema.toEncoded(InvoiceSchema)


const createOrderRecord = SqlSchema.findOne({
  Request: CreateOrderRecordSchema,
  Result: OrdersResource.table.storageSchema,
  execute: Effect.fn("Billing.createOrder.record")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    const value = OrderInsertSchema.make({
      tenantId: input.tenantId,
      number: input.number,
      customer: input.customer,
      status: "draft",
      totalMinor: 0,
      version: 1,
    })

    return yield* sql<SqliteRow>`
      INSERT INTO ${sql(OrdersResource.table.name)} ${sql.insert(value)}
      RETURNING *
    `

  }),
})

const orderNumberForTenant = SqlSchema.findOneOption({
  Request: TenantOrderNumberInputSchema,
  Result: IdRowSchema,
  execute: Effect.fn("Billing.orderNumberForTenant")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<SqliteRow>`
      SELECT ${sql("id")} FROM ${sql(OrdersResource.table.name)}
      WHERE ${sql("tenantId")} = ${input.tenantId} AND ${sql("number")} = ${input.number}
      LIMIT 1
    `

  }),
})

const invoiceNumberForTenant = SqlSchema.findOneOption({
  Request: TenantInvoiceNumberInputSchema,
  Result: IdRowSchema,
  execute: Effect.fn("Billing.invoiceNumberForTenant")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<SqliteRow>`
      SELECT ${sql("id")} FROM ${sql(InvoicesResource.table.name)}
      WHERE ${sql("tenantId")} = ${input.tenantId} AND ${sql("number")} = ${input.number}
      LIMIT 1
    `

  }),
})

const updateDraftOrderForLine = SqlSchema.findOneOption({
  Request: AddLineRecordSchema,
  Result: OrdersResource.table.storageSchema,
  execute: Effect.fn("Billing.updateDraftOrderForLine")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<SqliteRow>`
      UPDATE ${sql(OrdersResource.table.name)}
      SET ${sql("totalMinor")} = ${input.totalMinor}, ${sql("version")} = ${sql("version")} + 1
      WHERE ${sql("id")} = ${input.orderId}
        AND ${sql("tenantId")} = ${input.tenantId}
        AND ${sql("status")} = ${"draft"}
        AND ${sql("version")} = ${input.expectedVersion}
      RETURNING *
    `

  }),
})

const insertLineRecord = SqlSchema.findOne({
  Request: AddLineRecordSchema,
  Result: OrderLinesResource.table.storageSchema,
  execute: Effect.fn("Billing.insertLineRecord")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    const value = OrderLineInsertSchema.make({
      tenantId: input.tenantId,
      orderId: input.orderId,
      lineNumber: input.lineNumber,
      description: input.description,
      quantity: input.quantity,
      unitAmountMinor: input.unitAmountMinor,
    })

    return yield* sql<SqliteRow>`
      INSERT INTO ${sql(OrderLinesResource.table.name)} ${sql.insert(value)}
      RETURNING *
    `

  }),
})

const issueInvoiceRecord = SqlSchema.findOne({
  Request: IssueInvoiceRecordSchema,
  Result: InvoicesResource.table.storageSchema,
  execute: Effect.fn("Billing.issueInvoice.record")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    const value = InvoiceInsertSchema.make({
      tenantId: input.tenantId,
      orderId: input.orderId,
      number: input.number,
      status: "issued",
      totalMinor: input.totalMinor,
      version: 1,
    })

    return yield* sql<SqliteRow>`
      INSERT INTO ${sql(InvoicesResource.table.name)} ${sql.insert(value)}
      RETURNING *
    `

  }),
})

const markOrderInvoiced = SqlSchema.findOneOption({
  Request: IssueInvoiceRecordSchema,
  Result: OrdersResource.table.storageSchema,
  execute: Effect.fn("Billing.markOrderInvoiced")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<SqliteRow>`
      UPDATE ${sql(OrdersResource.table.name)}
      SET ${sql("status")} = ${"invoiced"}, ${sql("version")} = ${sql("version")} + 1
      WHERE ${sql("id")} = ${input.orderId}
        AND ${sql("tenantId")} = ${input.tenantId}
        AND ${sql("status")} = ${"draft"}
        AND ${sql("version")} = ${input.expectedVersion}
      RETURNING *
    `

  }),
})

const markInvoicePaid = SqlSchema.findOneOption({
  Request: PayInvoiceRecordSchema,
  Result: InvoicesResource.table.storageSchema,
  execute: Effect.fn("Billing.markInvoicePaid")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<SqliteRow>`
      UPDATE ${sql(InvoicesResource.table.name)}
      SET ${sql("status")} = ${"paid"}, ${sql("version")} = ${sql("version")} + 1
      WHERE ${sql("id")} = ${input.invoiceId}
        AND ${sql("tenantId")} = ${input.tenantId}
        AND ${sql("status")} = ${"issued"}
        AND ${sql("version")} = ${input.expectedVersion}
      RETURNING *
    `

  }),
})

const orderSummaryForTenant = SqlSchema.findOneOption({
  Request: ScopedOrderInputSchema,
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

const invoiceForTenant = SqlSchema.findOneOption({
  Request: ScopedInvoiceInputSchema,
  Result: InvoicesResource.table.storageSchema,
  execute: Effect.fn("Billing.invoiceForTenant")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<SqliteRow>`
      SELECT * FROM ${sql(InvoicesResource.table.name)}
      WHERE ${sql("id")} = ${input.invoiceId} AND ${sql("tenantId")} = ${input.tenantId}
      LIMIT 1
    `
  }),
})



const requireOrder = Effect.fn("Billing.requireOrder")(function* (
  orderId: string,
  tenantId: typeof TenantIdSchema.Type,
) {
  const found = yield* orderSummaryForTenant({ orderId, tenantId })
  if (Option.isNone(found)) return yield* OrderNotFound.make({ orderId })
  return found.value
})

const requireInvoice = Effect.fn("Billing.requireInvoice")(function* (
  invoiceId: string,
  tenantId: typeof TenantIdSchema.Type,
) {
  const found = yield* invoiceForTenant({ invoiceId, tenantId })
  if (Option.isNone(found)) return yield* InvoiceNotFound.make({ invoiceId })
  return found.value
})

const persistenceFailure = Effect.fn("Billing.persistenceFailure")(function* () {
  return yield* BillingUnavailable.make({})
})

const persistenceFailures = {
  SqlError: persistenceFailure,
  SchemaError: persistenceFailure,
}

const requiredRowFailures = { ...persistenceFailures, NoSuchElementError: persistenceFailure }

const createOrder = Effect.fn("Billing.createOrder")(function* (input: CreateOrderInput) {
  const subject = yield* Authorization.requireSubject(BillingWriteAuthorization)
  const sql = yield* SqlClient.SqlClient

  const transaction = Effect.gen(function* () {
    const numberInput = TenantOrderNumberInputSchema.make({ tenantId: subject.tenantId, number: input.number })
    const existing = yield* orderNumberForTenant(numberInput)
    if (Option.isSome(existing)) return yield* DuplicateOrderNumber.make({ number: input.number })
    const record = CreateOrderRecordSchema.make({ ...input, tenantId: subject.tenantId })
    return yield* createOrderRecord(record)
  })

  return yield* pipe(sql.withTransaction(transaction), Effect.catchTags(requiredRowFailures))
})

const addLine = Effect.fn("Billing.addLine")(function* (input: AddLineInput) {
  const subject = yield* Authorization.requireSubject(BillingWriteAuthorization)
  const sql = yield* SqlClient.SqlClient
  const lineTotal = input.quantity * input.unitAmountMinor
  if (!Number.isSafeInteger(lineTotal)) return yield* TotalOverflow.make({ orderId: input.orderId })

  const transaction = Effect.gen(function* () {
    const current = yield* requireOrder(input.orderId, subject.tenantId)

    if (current.order.version !== input.expectedVersion) {
      return yield* VersionConflict.make({ resource: "order", id: input.orderId, expectedVersion: input.expectedVersion })
    }

    if (current.order.status !== "draft") {
      return yield* InvalidOrderTransition.make({ orderId: input.orderId, action: "addLine", actual: current.order.status })
    }

    const totalMinor = current.order.totalMinor + lineTotal
    if (!Number.isSafeInteger(totalMinor)) return yield* TotalOverflow.make({ orderId: input.orderId })

    const record = AddLineRecordSchema.make({ ...input, tenantId: subject.tenantId, totalMinor })
    const changed = yield* updateDraftOrderForLine(record)

    if (Option.isNone(changed)) {
      return yield* VersionConflict.make({ resource: "order", id: input.orderId, expectedVersion: input.expectedVersion })
    }

    yield* insertLineRecord(record)
    return yield* requireOrder(input.orderId, subject.tenantId)
  })

  return yield* pipe(sql.withTransaction(transaction), Effect.catchTags(requiredRowFailures))
})

const issueInvoice = Effect.fn("Billing.issueInvoice")(function* (input: IssueInvoiceInput) {
  const subject = yield* Authorization.requireSubject(BillingWriteAuthorization)
  const sql = yield* SqlClient.SqlClient

  const transaction = Effect.gen(function* () {
    const current = yield* requireOrder(input.orderId, subject.tenantId)

    if (current.order.version !== input.expectedVersion) {
      return yield* VersionConflict.make({ resource: "order", id: input.orderId, expectedVersion: input.expectedVersion })
    }

    const invalidTransition = (actual: typeof current.order.status) => pipe(
      InvalidOrderTransition.make({ orderId: input.orderId, action: "issueInvoice", actual }),
      Effect.fail,
    )

    yield* pipe(
      Match.value(current.order.status),
      Match.when("draft", Function.constant(Effect.void)),
      Match.orElse(invalidTransition),
    )

    if (Array.isReadonlyArrayEmpty(current.lines)) {
      return yield* InvoiceRequiresLines.make({ orderId: input.orderId })
    }

    const numberInput = TenantInvoiceNumberInputSchema.make({ tenantId: subject.tenantId, number: input.number })
    const existing = yield* invoiceNumberForTenant(numberInput)
    if (Option.isSome(existing)) return yield* DuplicateInvoiceNumber.make({ number: input.number })

    const record = IssueInvoiceRecordSchema.make({
      ...input,
      tenantId: subject.tenantId,
      totalMinor: current.order.totalMinor,
    })

    const changed = yield* markOrderInvoiced(record)

    if (Option.isNone(changed)) {
      return yield* VersionConflict.make({ resource: "order", id: input.orderId, expectedVersion: input.expectedVersion })
    }

    return yield* issueInvoiceRecord(record)
  })

  return yield* pipe(sql.withTransaction(transaction), Effect.catchTags(requiredRowFailures))
})

const payInvoice = Effect.fn("Billing.payInvoice")(function* (input: PayInvoiceInput) {
  const subject = yield* Authorization.requireSubject(BillingWriteAuthorization)
  const sql = yield* SqlClient.SqlClient

  const transaction = Effect.gen(function* () {
    const current = yield* requireInvoice(input.invoiceId, subject.tenantId)

    if (current.version !== input.expectedVersion) {
      return yield* VersionConflict.make({ resource: "invoice", id: input.invoiceId, expectedVersion: input.expectedVersion })
    }

    if (current.status !== "issued") {
      return yield* InvalidInvoiceTransition.make({ invoiceId: input.invoiceId, action: "payInvoice", actual: current.status })
    }

    const record = PayInvoiceRecordSchema.make({ ...input, tenantId: subject.tenantId })
    const changed = yield* markInvoicePaid(record)

    if (Option.isNone(changed)) {
      return yield* VersionConflict.make({ resource: "invoice", id: input.invoiceId, expectedVersion: input.expectedVersion })
    }

    return changed.value
  })

  return yield* pipe(sql.withTransaction(transaction), Effect.catchTags(persistenceFailures))
})

const getOrder = Effect.fn("Billing.getOrder")(function* (input: GetOrderInput) {
  const subject = yield* Authorization.requireSubject(BillingReadAuthorization)
  yield* SqlClient.SqlClient

  const operation = Effect.gen(function* () {
    return yield* requireOrder(input.orderId, subject.tenantId)
  })

  return yield* pipe(operation, Effect.catchTags(persistenceFailures))
})

export const BillingSqlite = BillingRpcs.toLayer({
  "billing.createOrder": createOrder,
  "billing.addLine": addLine,
  "billing.issueInvoice": issueInvoice,
  "billing.payInvoice": payInvoice,
  "billing.getOrder": getOrder,
})
