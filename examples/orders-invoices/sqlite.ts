import { Array, Effect, Option, Schema, pipe } from "effect"
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
  MinorUnitsSchema,
  OrderNotFound,
  TenantIdSchema,
  TotalOverflow,
  VersionConflict,
} from "./domain.ts"

import { BillingReadAuthorization, BillingWriteAuthorization, InvoicesResource, OrderLinesResource, OrdersResource } from "./resources.ts"
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

const OrderSummaryStorageSchema = Schema.Struct({
  ...OrdersResource.table.rowSchema.fields,
  lines: Schema.fromJsonString(Schema.Array(OrderLinesResource.table.storageSchema)),
  invoice: Schema.NullOr(Schema.fromJsonString(InvoicesResource.table.storageSchema)),
})

interface OrderSummaryStorage extends Schema.Schema.Type<typeof OrderSummaryStorageSchema> {}

const IdRowSchema = Schema.Struct({ id: Schema.String })


const createOrderRecord = SqlSchema.findOne({
  Request: CreateOrderRecordSchema,
  Result: OrdersResource.table.storageSchema,
  execute: Effect.fn("Billing.createOrder.record")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<SqliteRow>`
      INSERT INTO ${sql(OrdersResource.table.name)}
        (${sql("tenantId")}, ${sql("number")}, ${sql("customer")}, ${sql("status")}, ${sql("totalMinor")}, ${sql("version")})
      VALUES (${input.tenantId}, ${input.number}, ${input.customer}, ${"draft"}, ${0}, ${1})
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

    return yield* sql<SqliteRow>`
      INSERT INTO ${sql(OrderLinesResource.table.name)}
        (${sql("tenantId")}, ${sql("orderId")}, ${sql("lineNumber")}, ${sql("description")}, ${sql("quantity")}, ${sql("unitAmountMinor")})
      VALUES (${input.tenantId}, ${input.orderId}, ${input.lineNumber}, ${input.description}, ${input.quantity}, ${input.unitAmountMinor})
      RETURNING *
    `

  }),
})

const issueInvoiceRecord = SqlSchema.findOne({
  Request: IssueInvoiceRecordSchema,
  Result: InvoicesResource.table.storageSchema,
  execute: Effect.fn("Billing.issueInvoice.record")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<SqliteRow>`
      INSERT INTO ${sql(InvoicesResource.table.name)}
        (${sql("tenantId")}, ${sql("orderId")}, ${sql("number")}, ${sql("status")}, ${sql("totalMinor")}, ${sql("version")})
      VALUES (${input.tenantId}, ${input.orderId}, ${input.number}, ${"issued"}, ${input.totalMinor}, ${1})
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
  Result: OrderSummaryStorageSchema,
  execute: Effect.fn("Billing.orderSummaryForTenant")(function* (input) {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<SqliteRow>`
      SELECT o.*,
        COALESCE((
          SELECT json_group_array(json_object(
            'id', l.id, 'tenantId', l.tenantId, 'orderId', l.orderId,
            'lineNumber', l.lineNumber, 'description', l.description,
            'quantity', l.quantity, 'unitAmountMinor', l.unitAmountMinor
          ))
          FROM (
            SELECT * FROM ${sql(OrderLinesResource.table.name)}
            WHERE ${sql("tenantId")} = o.${sql("tenantId")} AND ${sql("orderId")} = o.${sql("id")}
            ORDER BY ${sql("lineNumber")}
          ) l
        ), '[]') AS ${sql("lines")},
        (
          SELECT json_object(
            'id', i.id, 'tenantId', i.tenantId, 'orderId', i.orderId,
            'number', i.number, 'status', i.status, 'totalMinor', i.totalMinor, 'version', i.version
          )
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

const summaryFromStorage = Effect.fn("Billing.summaryFromStorage")(function* (
  stored: OrderSummaryStorage,
) {
  return OrderSummary.make({
    order: {
      id: stored.id,
      tenantId: stored.tenantId,
      number: stored.number,
      customer: stored.customer,
      status: stored.status,
      totalMinor: stored.totalMinor,
      version: stored.version,
    },
    lines: stored.lines,
    invoice: stored.invoice,
  })
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

    if (current.version !== input.expectedVersion) {
      return yield* VersionConflict.make({ resource: "order", id: input.orderId, expectedVersion: input.expectedVersion })
    }

    if (current.status !== "draft") {
      return yield* InvalidOrderTransition.make({ orderId: input.orderId, action: "addLine", actual: current.status })
    }

    const totalMinor = current.totalMinor + lineTotal
    if (!Number.isSafeInteger(totalMinor)) return yield* TotalOverflow.make({ orderId: input.orderId })

    const record = AddLineRecordSchema.make({ ...input, tenantId: subject.tenantId, totalMinor })
    const changed = yield* updateDraftOrderForLine(record)

    if (Option.isNone(changed)) {
      return yield* VersionConflict.make({ resource: "order", id: input.orderId, expectedVersion: input.expectedVersion })
    }

    yield* insertLineRecord(record)
    const summary = yield* requireOrder(input.orderId, subject.tenantId)
    return yield* summaryFromStorage(summary)
  })

  return yield* pipe(sql.withTransaction(transaction), Effect.catchTags(requiredRowFailures))
})

const issueInvoice = Effect.fn("Billing.issueInvoice")(function* (input: IssueInvoiceInput) {
  const subject = yield* Authorization.requireSubject(BillingWriteAuthorization)
  const sql = yield* SqlClient.SqlClient

  const transaction = Effect.gen(function* () {
    const current = yield* requireOrder(input.orderId, subject.tenantId)

    if (current.version !== input.expectedVersion) {
      return yield* VersionConflict.make({ resource: "order", id: input.orderId, expectedVersion: input.expectedVersion })
    }

    if (current.status !== "draft") {
      return yield* InvalidOrderTransition.make({ orderId: input.orderId, action: "issueInvoice", actual: current.status })
    }

    const summary = yield* summaryFromStorage(current)

    if (Array.isReadonlyArrayEmpty(summary.lines)) {
      return yield* InvoiceRequiresLines.make({ orderId: input.orderId })
    }

    const numberInput = TenantInvoiceNumberInputSchema.make({ tenantId: subject.tenantId, number: input.number })
    const existing = yield* invoiceNumberForTenant(numberInput)
    if (Option.isSome(existing)) return yield* DuplicateInvoiceNumber.make({ number: input.number })

    const record = IssueInvoiceRecordSchema.make({
      ...input,
      tenantId: subject.tenantId,
      totalMinor: summary.order.totalMinor,
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
    const stored = yield* requireOrder(input.orderId, subject.tenantId)
    return yield* summaryFromStorage(stored)
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
