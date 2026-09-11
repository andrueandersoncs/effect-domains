import { expect, it } from "@effect/vitest"
import { Effect, Result, pipe } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
import { Application } from "effect-domains/application"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { TestIdentity, sessionFor } from "./identity-fixture.ts"
import { BillingApplication } from "../examples/orders-invoices/application.ts"
import { BillingMigrations } from "../examples/orders-invoices/migrations.ts"
import { InvoiceNumberSchema, OrderNumberSchema } from "../examples/orders-invoices/domain.ts"
const sqlite = SqliteBunRuntime.sqlClient(":memory:", { migrations: BillingMigrations })
const orderNumber = OrderNumberSchema.make("SO-1")
const invoiceNumber = InvoiceNumberSchema.make("INV-1")

const billingTest = Effect.gen(function* () {
  yield* Application.prepare(BillingApplication)
  const client = yield* RpcTest.makeClient(BillingApplication.group)
  const alice = yield* sessionFor("alice")
  const reader = yield* sessionFor("bob")
  const outsider = yield* sessionFor("outsider")
  const database = yield* SqlClient.SqlClient
  const aliceOrder = yield* client["billing.createOrder"]({ number: orderNumber, customer: "Alice customer" }, { headers: alice })
  const outsiderOrder = yield* client["billing.createOrder"]({ number: orderNumber, customer: "Other customer" }, { headers: outsider })
  expect(aliceOrder.number).toBe(outsiderOrder.number)
  expect(aliceOrder.tenantId).toBe("acme")
  expect(outsiderOrder.tenantId).toBe("other")
  const readerOrder = yield* client["orders.get"]({ id: aliceOrder.id }, { headers: reader })
  expect(readerOrder.id).toBe(aliceOrder.id)

  const hiddenGeneratedRead = yield* pipe(client["orders.get"]({ id: aliceOrder.id }, { headers: outsider }), Effect.result)
  expect(hiddenGeneratedRead).toMatchObject({ _tag: "Failure", failure: { _tag: "ResourceNotFound" } })


  const duplicate = yield* pipe(client["billing.createOrder"]({ number: orderNumber, customer: "Duplicate" }, { headers: alice }), Effect.result)

  expect(duplicate).toMatchObject({ _tag: "Failure", failure: { _tag: "DuplicateOrderNumber", number: "SO-1" } })

  const hiddenRead = yield* pipe(client["billing.getOrder"]({ orderId: aliceOrder.id }, { headers: outsider }), Effect.result)

  expect(hiddenRead).toMatchObject({ _tag: "Failure", failure: { _tag: "OrderNotFound", orderId: aliceOrder.id } })

  const hiddenMutation = yield* pipe(client["billing.addLine"]({
    orderId: aliceOrder.id,
    expectedVersion: 1,
    lineNumber: 1,
    description: "Hidden mutation",
    quantity: 1,
    unitAmountMinor: 99,
  }, { headers: outsider }), Effect.result)

  expect(hiddenMutation).toMatchObject({ _tag: "Failure", failure: { _tag: "OrderNotFound", orderId: aliceOrder.id } })

  const deniedReader = yield* pipe(client["billing.addLine"]({
    orderId: aliceOrder.id,
    expectedVersion: 1,
    lineNumber: 1,
    description: "Reader mutation",
    quantity: 1,
    unitAmountMinor: 99,
  }, { headers: reader }), Effect.result)

  expect(deniedReader).toMatchObject({ _tag: "Failure", failure: { _tag: "Forbidden" } })

  const emptyInvoice = yield* pipe(client["billing.issueInvoice"]({
    orderId: aliceOrder.id,
    expectedVersion: 1,
    number: invoiceNumber,
  }, { headers: alice }), Effect.result)

  expect(emptyInvoice).toMatchObject({ _tag: "Failure", failure: { _tag: "InvoiceRequiresLines", orderId: aliceOrder.id } })

  const updated = yield* client["billing.addLine"]({
    orderId: aliceOrder.id,
    expectedVersion: 1,
    lineNumber: 1,
    description: "Consulting",
    quantity: 2,
    unitAmountMinor: 1250,
  }, { headers: alice })

  expect(updated.order.totalMinor).toBe(2500)
  expect(updated.order.version).toBe(2)
  expect(updated.lines).toHaveLength(1)

  const staleLine = yield* pipe(client["billing.addLine"]({
    orderId: aliceOrder.id,
    expectedVersion: 1,
    lineNumber: 2,
    description: "Stale",
    quantity: 1,
    unitAmountMinor: 1,
  }, { headers: alice }), Effect.result)

  expect(staleLine).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "VersionConflict", resource: "order", id: aliceOrder.id, expectedVersion: 1 },
  })

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

  expect(rejectedInvoice).toMatchObject({ _tag: "Failure", failure: { _tag: "BillingUnavailable" } })
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

  const staleIssue = yield* pipe(client["billing.issueInvoice"]({
    orderId: aliceOrder.id,
    expectedVersion: 2,
    number: invoiceNumber,
  }, { headers: alice }), Effect.result)

  expect(staleIssue).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "VersionConflict", resource: "order", id: aliceOrder.id, expectedVersion: 2 },
  })

  const paid = yield* client["billing.payInvoice"]({ invoiceId: invoice.id, expectedVersion: 1 }, { headers: alice })
  expect(paid.status).toBe("paid")
  expect(paid.version).toBe(2)

  const stalePayment = yield* pipe(client["billing.payInvoice"]({ invoiceId: invoice.id, expectedVersion: 1 }, { headers: alice }), Effect.result)

  expect(stalePayment).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "VersionConflict", resource: "invoice", id: invoice.id, expectedVersion: 1 },
  })

  const illegalPayment = yield* pipe(client["billing.payInvoice"]({ invoiceId: invoice.id, expectedVersion: 2 }, { headers: alice }), Effect.result)

  expect(illegalPayment).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "InvalidInvoiceTransition", invoiceId: invoice.id, action: "payInvoice", actual: "paid" },
  })
})

it.effect("keeps tenant-scoped billing lifecycle, foreign keys, transactions, and versions explicit", () => pipe(
  billingTest,
  Effect.provide(BillingApplication.handlers),
  Effect.provide(AuthorizationRpc.layer),
  Effect.provide(TestIdentity),
  Effect.provide(sqlite),
))
