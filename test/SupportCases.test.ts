import { BunServices } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Array, Effect, Equivalence, FileSystem, HashSet, Path, Struct, pipe } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
import { Application } from "effect-domains/application"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { ApplicationInspect } from "effect-domains/application-inspect"
import { SupportCasesApplication } from "@effect-domains/example-support-cases/application"
import { SupportCasesMigrations } from "@effect-domains/example-support-cases/migrations"
import { TestIdentity, sessionFor } from "./identity-fixture.ts"

const sqlite = SqliteBunRuntime.sqlClient(":memory:", {
  migrations: SupportCasesMigrations,
})

const supportCasesTest = Effect.gen(function* () {
  yield* Application.prepare(SupportCasesApplication)
  const client = yield* RpcTest.makeClient(SupportCasesApplication.group)
  const database = yield* SqlClient.SqlClient
  const readerSession = yield* sessionFor("bob")
  const adminSession = yield* sessionFor("admin")

  yield* client["support_customers.create"]({ id: "acme", name: "Acme Industries" })
  yield* client["support_agents.create"]({ id: "sam", name: "Sam", onDuty: false })

  const opened = yield* client["support.openCase"]({
    customerId: "acme",
    subject: "Cannot export quarterly report",
    priority: "high",
  })

  expect(opened.status).toBe("open")
  expect(opened.version).toBe(1)
  expect(opened.assignedAgentId).toBeNull()

  const board = yield* client["support.board"]({
    filter: { status: "open", priority: "high" },
    range: { openedAt: { from: opened.openedAt, to: opened.openedAt } },
    limit: 10,
  })

  expect(board.items).toMatchObject([{
    id: opened.id,
    customerName: "Acme Industries",
    agentName: null,
    agentOnDuty: null,
    status: "open",
    version: 1,
  }])

  const triaged = yield* client["support.advanceCase"]({
    caseId: opened.id,
    expectedVersion: 1,
    action: "triage",
    note: "Reproduced from the customer export payload.",
  })

  expect(triaged.status).toBe("triaged")
  expect(triaged.version).toBe(2)

  const offDuty = yield* pipe(client["support.advanceCase"]({
    caseId: opened.id,
    expectedVersion: 2,
    action: "assign",
    assignedAgentId: "sam",
  }), Effect.result)

  expect(offDuty).toMatchObject({ _tag: "Failure", failure: { _tag: "AgentOffDuty", agentId: "sam" } })

  yield* client["support_agents.patch"]({ key: "sam", changes: { onDuty: true } })

  const assigned = yield* client["support.advanceCase"]({
    caseId: opened.id,
    expectedVersion: 2,
    action: "assign",
    assignedAgentId: "sam",
  })

  expect(assigned.status).toBe("assigned")
  expect(assigned.version).toBe(3)
  expect(assigned.assignedAgentId).toBe("sam")

  const staleResolve = yield* pipe(client["support.advanceCase"]({
    caseId: opened.id,
    expectedVersion: 2,
    action: "resolve",
  }), Effect.result)

  expect(staleResolve).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "VersionConflict",
      resource: "support_cases",
      key: opened.id,
      expectedVersion: 2,
    },
  })

  yield* database`CREATE TRIGGER reject_case_event BEFORE INSERT ON support_case_events
    BEGIN SELECT RAISE(ABORT, 'event storage unavailable'); END`

  const interrupted = yield* pipe(client["support.advanceCase"]({
    caseId: opened.id,
    expectedVersion: 3,
    action: "resolve",
  }), Effect.result)

  expect(interrupted).toMatchObject({ _tag: "Failure", failure: { _tag: "SupportCasesUnavailable" } })

  const afterRollback = yield* client["support_cases.get"]({ id: opened.id })
  expect(afterRollback.status).toBe("assigned")
  expect(afterRollback.version).toBe(3)

  yield* database`DROP TRIGGER reject_case_event`

  const resolved = yield* client["support.advanceCase"]({
    caseId: opened.id,
    expectedVersion: 3,
    action: "resolve",
    note: "Export permission repaired.",
  })

  expect(resolved.status).toBe("resolved")
  expect(resolved.version).toBe(4)

  const detail = yield* client["support.caseDetail"]({ caseId: opened.id })
  expect(detail.case).toEqual(resolved)
  expect(detail.customer.name).toBe("Acme Industries")
  expect(detail.agent).toMatchObject({ id: "sam", name: "Sam", onDuty: true })
  const eventKinds = Array.map(detail.events, Struct.get("kind"))
  const lastEvent = Array.last(detail.events)
  expect(eventKinds).toEqual(["opened", "triaged", "assigned", "resolved"])
  expect(lastEvent).toMatchObject({ _tag: "Some", value: { note: "Export permission repaired." } })

  yield* database`CREATE TRIGGER reject_case_audit BEFORE INSERT ON support_case_audits
    BEGIN SELECT RAISE(ABORT, 'audit storage unavailable'); END`


  const auditInterrupted = yield* pipe(client["support.advanceCase"]({
    caseId: opened.id,
    expectedVersion: 4,
    action: "reopen",
  }), Effect.result)

  expect(auditInterrupted).toMatchObject({ _tag: "Failure", failure: { _tag: "SupportCasesUnavailable" } })
  const afterAuditRollback = yield* client["support_cases.get"]({ id: opened.id })
  expect(afterAuditRollback).toMatchObject({ status: "resolved", version: 4 })
  yield* database`DROP TRIGGER reject_case_audit`


  const anonymousAudit = yield* pipe(
    client["support.auditTrail"]({ caseId: opened.id }),
    Effect.result,
  )

  expect(anonymousAudit).toMatchObject({ _tag: "Failure", failure: { _tag: "Unauthenticated" } })

  const deniedAudit = yield* pipe(
    client["support.auditTrail"]({ caseId: opened.id }, { headers: readerSession }),
    Effect.result,
  )

  expect(deniedAudit).toMatchObject({ _tag: "Failure", failure: { _tag: "Forbidden" } })
  const audit = yield* client["support.auditTrail"]({ caseId: opened.id }, { headers: adminSession })
  expect(audit).toHaveLength(4)
  const actions = Array.map(audit, Struct.get("action"))
  expect(actions).toEqual(["open", "triage", "assign", "resolve"])
  const sameString = Equivalence.strictEqual<string>()

  const validAuditEvent = (event: typeof audit[number]) => {
    const publicActor = sameString(event.actorId, "public-api")
    const succeeded = sameString(event.outcome, "succeeded")
    return publicActor && succeeded
  }

  const validAudit = Array.every(audit, validAuditEvent)
  expect(validAudit).toBe(true)
  const auditIds = Array.map(audit, Struct.get("id"))
  const distinctIds = HashSet.fromIterable(auditIds)
  const distinctAuditCount = HashSet.size(distinctIds)
  expect(distinctAuditCount).toBe(4)
  const inspection = ApplicationInspect.describe(SupportCasesApplication)

  const auditOperation = (operation: typeof inspection.operations[number]) =>
    operation.name.startsWith("support_case_audits.")

  const exposesAuditResource = Array.some(inspection.operations, auditOperation)
  expect(exposesAuditResource).toBe(false)
})

it.effect("keeps the support-case lifecycle, joined board, history, versions, and rollback explicit", () => pipe(
  supportCasesTest,
  Effect.provide(SupportCasesApplication.handlers),
  Effect.provide(AuthorizationRpc.layer),
  Effect.provide(TestIdentity),
  Effect.provide(sqlite),
))

it.effect("persists application-owned audit evidence across a database restart", Effect.fn(
  "SupportCases.auditPersistence",
)(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fileSystem.makeTempDirectoryScoped()
  const databasePath = path.join(directory, "support-cases.sqlite")

  const databaseLayer = SqliteBunRuntime.sqlClient(databasePath, {
    migrations: SupportCasesMigrations,
  })

  yield* pipe(
    Effect.gen(function* () {
      yield* Application.prepare(SupportCasesApplication)
      const sql = yield* SqlClient.SqlClient

      yield* sql`INSERT INTO support_case_audits
        (id, occurredAt, action, outcome, actorId, targetId, traceId)
        VALUES ('restart-audit', '2026-01-01T00:00:00.000Z', 'open', 'succeeded', 'restart-probe', 'case-1', NULL)`

    }),
    Effect.provide(databaseLayer),
  )


  const persisted = yield* pipe(
    Effect.gen(function* () {
      yield* Application.prepare(SupportCasesApplication)
      const sql = yield* SqlClient.SqlClient
      return yield* sql<{ readonly id: string }>`SELECT id FROM support_case_audits WHERE id = 'restart-audit'`
    }),
    Effect.provide(databaseLayer),
  )

  expect(persisted).toEqual([{ id: "restart-audit" }])
}, Effect.scoped, Effect.provide(BunServices.layer)))
