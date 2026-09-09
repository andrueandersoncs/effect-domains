import { Array, Effect, Equivalence, Option, Schema, pipe } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import { AuthorizationSubject, Forbidden } from "effect-domains/authorization"
import { ExampleSubjectSchema } from "@effect-domains/example-support/authentication"
import { Billing, OrderSummary } from "./contracts.ts"

import {
  type AddLineInput,
  AddLineInputSchema,
  type CreateOrderInput,
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
  OrderNotFound,
  OrderSchema,
  TenantIdSchema,
  TotalOverflow,
  VersionConflict,
} from "./domain.ts"

import { InvoicesResource, OrderLinesResource, OrdersResource } from "./resources.ts"
type SqliteRow = Readonly<Record<string, unknown>>

const ScopedOrderInputSchema = Schema.Struct({
  orderId: Schema.String,
  tenantId: TenantIdSchema,
})

interface ScopedOrderInput extends Schema.Schema.Type<typeof ScopedOrderInputSchema> {}

const CreateOrderRecordSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  number: Schema.String,
  customer: Schema.NonEmptyString,
})

interface CreateOrderRecord extends Schema.Schema.Type<typeof CreateOrderRecordSchema> {}

const AddLineRecordSchema = Schema.Struct({
  ...AddLineInputSchema.fields,
  tenantId: TenantIdSchema,
  totalMinor: Schema.Int,
})

interface AddLineRecord extends Schema.Schema.Type<typeof AddLineRecordSchema> {}

const IssueInvoiceRecordSchema = Schema.Struct({
  ...IssueInvoiceInputSchema.fields,
  tenantId: TenantIdSchema,
  totalMinor: Schema.Int,
})

interface IssueInvoiceRecord extends Schema.Schema.Type<typeof IssueInvoiceRecordSchema> {}

const PayInvoiceRecordSchema = Schema.Struct({
  ...PayInvoiceInputSchema.fields,
  tenantId: TenantIdSchema,
})

interface PayInvoiceRecord extends Schema.Schema.Type<typeof PayInvoiceRecordSchema> {}
const NullableJsonSchema = Schema.NullOr(Schema.String)

const OrderSummaryStorageSchema = Schema.Struct({
  id: OrdersResource.table.identifierSchema,
  ...OrderSchema.fields,
  lines: Schema.String,
  invoice: NullableJsonSchema,
})

interface OrderSummaryStorage extends Schema.Schema.Type<typeof OrderSummaryStorageSchema> {}
const IdRowSchema = Schema.Struct({ id: Schema.String })
interface IdRow extends Schema.Schema.Type<typeof IdRowSchema> {}
const TenantNumberInputSchema = Schema.Struct({ tenantId: TenantIdSchema, number: Schema.String })
interface TenantNumberInput extends Schema.Schema.Type<typeof TenantNumberInputSchema> {}
const OrderLinesSchema = Schema.Array(OrderLinesResource.table.rowSchema)

const BillingSubjectSchema = Schema.Struct({
  ...ExampleSubjectSchema.fields,
  tenantId: TenantIdSchema,
})

interface BillingSubject extends Schema.Schema.Type<typeof BillingSubjectSchema> {}

const createOrderRecord = SqlSchema.findOne({
  Request: CreateOrderRecordSchema,
  Result: OrdersResource.table.rowSchema,
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
  Request: TenantNumberInputSchema,
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
  Request: TenantNumberInputSchema,
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
  Result: OrdersResource.table.rowSchema,
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
  Result: OrderLinesResource.table.rowSchema,
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
  Result: InvoicesResource.table.rowSchema,
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
  Result: OrdersResource.table.rowSchema,
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
  Result: InvoicesResource.table.rowSchema,
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

const decodeJson = <S extends Schema.Top>(schema: S) => (source: string) =>
  pipe(
    Effect.try({ try: () => JSON.parse(source), catch: () => BillingUnavailable.make({}) }),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  )

const summaryFromStorage = Effect.fn("Billing.summaryFromStorage")(function* (
  stored: OrderSummaryStorage,
) {
  const lines = yield* pipe(stored.lines, decodeJson(OrderLinesSchema))

  const invoice = yield* pipe(
    Option.fromNullishOr(stored.invoice),
    Option.match({ onNone: () => Effect.succeed(null), onSome: decodeJson(InvoicesResource.table.rowSchema) }),
  )

  return OrderSummary.make({ order: stored, lines, invoice })
})

const authenticatedSubject = Effect.fn("Billing.authenticatedSubject")(function* () {
  const raw = yield* AuthorizationSubject

  return yield* pipe(
    Schema.decodeUnknownEffect(BillingSubjectSchema)(raw),
    Effect.catchTag("SchemaError", () => Forbidden.make({})),
  )
})

const billingSubject = Effect.fn("Billing.subject")(function* () {
  const subject = yield* authenticatedSubject()
  const editor = Array.contains(subject.roles, "editor")
  const administrator = Array.contains(subject.roles, "admin")
  const canEdit = editor || administrator

  if (!canEdit) return yield* Forbidden.make({})
  return subject
})

const requireOrder = Effect.fn("Billing.requireOrder")(function* (
  orderId: string,
  tenantId: BillingSubject["tenantId"],
) {
  const found = yield* orderSummaryForTenant({ orderId, tenantId })
  if (Option.isNone(found)) return yield* OrderNotFound.make({ orderId })
  return found.value
})

const requireInvoice = Effect.fn("Billing.requireInvoice")(function* (
  invoiceId: string,
  tenantId: BillingSubject["tenantId"],
) {
  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<SqliteRow>`
    SELECT * FROM ${sql(InvoicesResource.table.name)}
    WHERE ${sql("id")} = ${invoiceId} AND ${sql("tenantId")} = ${tenantId}
    LIMIT 1
  `

  const first = Array.get(rows, 0)
  if (Option.isNone(first)) return yield* InvoiceNotFound.make({ invoiceId })
  return yield* Schema.decodeUnknownEffect(InvoicesResource.table.rowSchema)(first.value)
})

const billingSqliteEffect = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const createOrder = Effect.fn("Billing.createOrder")(function* (input: CreateOrderInput) {
    const subject = yield* billingSubject()

    const transaction = Effect.gen(function* () {
      const numberInput = TenantNumberInputSchema.make({ tenantId: subject.tenantId, number: input.number })
      const existing = yield* orderNumberForTenant(numberInput)
      if (Option.isSome(existing)) return yield* DuplicateOrderNumber.make({ number: input.number })
      const record = CreateOrderRecordSchema.make({ ...input, tenantId: subject.tenantId })
      return yield* createOrderRecord(record)
    })

    return yield* sql.withTransaction(transaction)
  })

  const addLine = Effect.fn("Billing.addLine")(function* (input: AddLineInput) {
    const subject = yield* billingSubject()
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

    return yield* sql.withTransaction(transaction)
  })

  const issueInvoice = Effect.fn("Billing.issueInvoice")(function* (input: IssueInvoiceInput) {
    const subject = yield* billingSubject()

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

      const numberInput = TenantNumberInputSchema.make({ tenantId: subject.tenantId, number: input.number })
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

    return yield* sql.withTransaction(transaction)
  })

  const payInvoice = Effect.fn("Billing.payInvoice")(function* (input: PayInvoiceInput) {
    const subject = yield* billingSubject()

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

    return yield* sql.withTransaction(transaction)
  })

  const getOrder = Effect.fn("Billing.getOrder")(function* (input: GetOrderInput) {
    const subject = yield* authenticatedSubject()
    const stored = yield* requireOrder(input.orderId, subject.tenantId)
    return yield* summaryFromStorage(stored)
  })

  return {
    "billing.createOrder": createOrder,
    "billing.addLine": addLine,
    "billing.issueInvoice": issueInvoice,
    "billing.payInvoice": payInvoice,
    "billing.getOrder": getOrder,
  }
})

const persistenceFailure = Effect.fn("Billing.persistenceFailure")(function* () {
  return yield* BillingUnavailable.make({})
})

export const BillingSqlite = Billing.layer(billingSqliteEffect, {
  SqlError: persistenceFailure,
  SchemaError: persistenceFailure,
  NoSuchElementError: persistenceFailure,
})
