import { expect, it } from "@effect/vitest"
import { Effect, Result, pipe } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
import { Application } from "effect-domains/application"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { SchemaStore } from "effect-domains/migrations"
import { TestIdentity, sessionFor } from "./identity-fixture.ts"
import { BillingApplication } from "@effect-domains/example-orders-invoices/application"
import { BillingMigrations } from "@effect-domains/example-orders-invoices/migrations"
import { AddLineInputSchema, InvoiceNumberSchema, OrderNumberSchema } from "@effect-domains/example-orders-invoices/domain"

const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: BillingMigrations })
const orderNumber = OrderNumberSchema.make("SO-1")
const invoiceNumber = InvoiceNumberSchema.make("INV-1")

const billingTest = Effect.gen(function* () {
  const schemaStore = yield* SchemaStore

  yield* Application.prepare(BillingApplication, schemaStore)

  const client = yield* RpcTest.makeClient(BillingApplication.group)
  const alice = yield* sessionFor("alice")
  const reader = yield* sessionFor("bob")
  const outsider = yield* sessionFor("outsider")
  const database = yield* SqlClient.SqlClient
  const aliceOrder = yield* client["billing.createOrder"]({ number: orderNumber, customer: "Alice customer" }, { headers: alice })
  const outsiderOrder = yield* client["billing.createOrder"]({ number: orderNumber, customer: "Other customer" }, { headers: outsider })

  const addLine = Effect.fn("OrdersInvoices.addLine")(function* (
    input: Omit<Parameters<typeof client["billing.addLine"]>[0], "orderId">,
    headers: typeof alice,
  ) {
    const payload = AddLineInputSchema.make({ orderId: aliceOrder.id, ...input })

    return yield* client["billing.addLine"](payload, { headers })
  })

  expect(aliceOrder.number).toBe(outsiderOrder.number)
  expect(aliceOrder.tenantId).toBe("acme")
  expect(outsiderOrder.tenantId).toBe("other")

  const readerOrder = yield* client["orders.get"]({ id: aliceOrder.id }, { headers: reader })

  expect(readerOrder.id).toBe(aliceOrder.id)

  const hiddenGeneratedRead = yield* pipe(client["orders.get"]({ id: aliceOrder.id }, { headers: outsider }), Effect.result)

  expect(hiddenGeneratedRead._tag).toBe("Failure")

  expect(hiddenGeneratedRead).toHaveProperty("failure._tag", "ResourceNotFound")


  const duplicate = yield* pipe(client["billing.createOrder"]({ number: orderNumber, customer: "Duplicate" }, { headers: alice }), Effect.result)

  expect(duplicate._tag).toBe("Failure")

  expect(duplicate).toHaveProperty("failure._tag", "DuplicateOrderNumber")
  expect(duplicate).toMatchObject({ failure: { number: "SO-1" } })

  const hiddenRead = yield* pipe(client["billing.getOrder"]({ orderId: aliceOrder.id }, { headers: outsider }), Effect.result)

  expect(hiddenRead._tag).toBe("Failure")

  expect(hiddenRead).toHaveProperty("failure._tag", "OrderNotFound")
  expect(hiddenRead).toMatchObject({ failure: { orderId: aliceOrder.id } })

  const hiddenMutation = yield* pipe(addLine({ expectedVersion: 1,
  lineNumber: 1,
  description: "Hidden mutation",
  quantity: 1,
  unitAmountMinor: 99, }, outsider), Effect.result)

  expect(hiddenMutation._tag).toBe("Failure")

  expect(hiddenMutation).toHaveProperty("failure._tag", "OrderNotFound")
  expect(hiddenMutation).toMatchObject({ failure: { orderId: aliceOrder.id } })

  const deniedReader = yield* pipe(addLine({ expectedVersion: 1,
  lineNumber: 1,
  description: "Reader mutation",
  quantity: 1,
  unitAmountMinor: 99, }, reader), Effect.result)

  expect(deniedReader._tag).toBe("Failure")

  expect(deniedReader).toHaveProperty("failure._tag", "Forbidden")

  const emptyInvoice = yield* pipe(client["billing.issueInvoice"]({
    orderId: aliceOrder.id,
    expectedVersion: 1,
    number: invoiceNumber,
  }, { headers: alice }), Effect.result)

  expect(emptyInvoice._tag).toBe("Failure")

  expect(emptyInvoice).toHaveProperty("failure._tag", "InvoiceRequiresLines")
  expect(emptyInvoice).toMatchObject({ failure: { orderId: aliceOrder.id } })

  const updated = yield* addLine({ expectedVersion: 1,
  lineNumber: 1,
  description: "Consulting",
  quantity: 2,
  unitAmountMinor: 1250, }, alice)

  expect(updated.order.totalMinor).toBe(2500)
  expect(updated.order.version).toBe(2)
  expect(updated.lines).toHaveLength(1)

  const staleLine = yield* pipe(addLine({ expectedVersion: 1,
  lineNumber: 2,
  description: "Stale",
  quantity: 1,
  unitAmountMinor: 1, }, alice), Effect.result)

  expect(staleLine._tag).toBe("Failure")

  expect(staleLine).toHaveProperty("failure._tag", "VersionConflict")
  expect(staleLine).toMatchObject({ failure: { resource: "orders", key: aliceOrder.id, expectedVersion: 1 } })

  const forgedLine = yield* pipe(database`
    INSERT INTO order_lines (id, tenantId, orderId, lineNumber, description, quantity, unitAmountMinor)
    VALUES ('00000000-0000-7000-8000-000000000001', 'acme', ${outsiderOrder.id}, 99, 'forged', 1, 1)
  `, Effect.result)

  const foreignKeyRejected = Result.isFailure(forgedLine)

  expect(foreignKeyRejected).toBe(true)
  yield* database`CREATE TRIGGER reject_invoice BEFORE INSERT ON invoices BEGIN SELECT RAISE(ABORT, 'reject invoice'); END`

  const rejectedInvoice = yield* pipe(client["billing.issueInvoice"]({
    orderId: aliceOrder.id,
    expectedVersion: 2,
    number: invoiceNumber,
  }, { headers: alice }), Effect.result)

  expect(rejectedInvoice._tag).toBe("Failure")

  expect(rejectedInvoice).toHaveProperty("failure._tag", "BillingUnavailable")

  yield* database`DROP TRIGGER reject_invoice`

  const afterRollback = yield* client["billing.getOrder"]({ orderId: aliceOrder.id }, { headers: alice })

  expect(afterRollback.order.status).toBe("draft")
  expect(afterRollback.order.version).toBe(2)
  expect(afterRollback.invoice).toBeNull()

  const invoice = yield* client["billing.issueInvoice"]({
    orderId: aliceOrder.id,
    expectedVersion: 2,
    number: invoiceNumber,
  }, { headers: alice })

  expect(invoice.status).toBe("issued")
  expect(invoice.totalMinor).toBe(2500)


  const paid = yield* client["billing.payInvoice"]({ invoiceId: invoice.id, expectedVersion: 1 }, { headers: alice })

  expect(paid.status).toBe("paid")
  expect(paid.version).toBe(2)

  const stalePayment = yield* pipe(client["billing.payInvoice"]({ invoiceId: invoice.id, expectedVersion: 1 }, { headers: alice }), Effect.result)
  const illegalPayment = yield* pipe(client["billing.payInvoice"]({ invoiceId: invoice.id, expectedVersion: 2 }, { headers: alice }), Effect.result)

  expect(stalePayment._tag).toBe("Failure")

  expect(stalePayment).toHaveProperty("failure._tag", "InvalidInvoiceTransition")
  expect(stalePayment).toMatchObject({ failure: { key: invoice.id, action: "pay", actual: "paid" } })

  expect(illegalPayment._tag).toBe("Failure")

  expect(illegalPayment).toHaveProperty("failure._tag", "InvalidInvoiceTransition")
  expect(illegalPayment).toMatchObject({ failure: { key: invoice.id, action: "pay", actual: "paid" } })
})

it.effect("keeps tenant-scoped billing lifecycle, foreign keys, transactions, and versions explicit", () => pipe(
  billingTest,
  Effect.provide(BillingApplication.handlers),
  Effect.provide(AuthorizationRpc.layer),
  Effect.provide(TestIdentity),
  Effect.provide(sqlite),
))
