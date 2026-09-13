import { expect, it } from "@effect/vitest"
import { Array, Effect, Struct, pipe } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
import { Application } from "effect-domains/application"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { SupportCasesApplication } from "../examples/support-cases/application.ts"
import { SupportCasesMigrations } from "../examples/support-cases/migrations.ts"

const sqlite = SqliteBunRuntime.sqlClient(":memory:", {
  migrations: SupportCasesMigrations,
})

const supportCasesTest = Effect.gen(function* () {
  yield* Application.prepare(SupportCasesApplication)
  const client = yield* RpcTest.makeClient(SupportCasesApplication.group)
  const database = yield* SqlClient.SqlClient

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
})

it.effect("keeps the support-case lifecycle, joined board, history, versions, and rollback explicit", () => pipe(
  supportCasesTest,
  Effect.provide(SupportCasesApplication.handlers),
  Effect.provide(sqlite),
))
