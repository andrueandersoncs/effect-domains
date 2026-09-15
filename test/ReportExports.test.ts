import { BunServices } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Array, Effect, FileSystem, HashSet, Layer, Path, Schema, Struct, pipe } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
import { Application } from "effect-domains/application"
import { AuthorizationRpc } from "effect-domains/authorization-rpc"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { Command } from "effect-domains/command"
import { Resource } from "effect-domains/resource"
import { ReportExportsApplication } from "../examples/report-exports/application.ts"
import { appendReportExportAudit, ReportExportAuditOperation } from "../examples/report-exports/audit.ts"
import { ReportExportMigrations } from "../examples/report-exports/migrations.ts"
import { TestIdentity, sessionFor } from "./identity-fixture.ts"
import { ReportExportRequestSchema } from "../examples/report-exports/contracts.ts"

import {
  ReportExportExecutionsResource,
  ReportExportExecutionStore,
  ReportExportExecutionStoreLive,
} from "../examples/report-exports/executions.ts"

import { ReportArtifactOutput } from "../examples/report-exports/output.ts"
import { makeReportExportJob } from "../examples/report-exports/workflow.ts"
import { writeReportArtifact } from "../examples/report-exports/writer.ts"
import { prepareTables } from "./prepare-tables.ts"

const requestInput = {
  report: {
    reportId: "lifecycle-2026",
    reportingPeriod: {
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-02-01T00:00:00.000Z",
    },
    currency: "USD",
    releasePolicy: "automatic",
  },
  lines: [{
    accountCode: "4000",
    description: "Revenue",
    direction: "credit",
    amountMinor: 125000,
  }],
}

const RequestJsonSchema = Schema.toCodecJson(ReportExportRequestSchema)
const requestEffect = Schema.decodeUnknownEffect(RequestJsonSchema)(requestInput)
const reportExportExecutionsTable = Resource.table(ReportExportExecutionsResource)
const reportAuditCommands = Command.bundle(ReportExportAuditOperation)


const executionStore = (filename: string) => {
  const tables = prepareTables([reportExportExecutionsTable])
  const preparedTables = Layer.effectDiscard(tables)
  const services = Layer.mergeAll(preparedTables, ReportExportExecutionStoreLive)
  const database = SqliteBunRuntime.sqlClient(filename, { migrations: [] })

  return pipe(services, Layer.provide(database))
}

it.effect("persists cancellation before dispatch and rejects cancellation after writing begins", Effect.fn("ReportExports.cancellation")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fileSystem.makeTempDirectoryScoped()
  const database = path.join(directory, "report-exports.sqlite")
  const storeLayer = executionStore(database)

  yield* pipe(Effect.gen(function* () {
    const request = yield* requestEffect
    const store = yield* ReportExportExecutionStore
    const accepted = yield* store.accept({ id: "cancel-before-dispatch", tenantId: "acme", request })

    expect(accepted.status).toBe("accepted")

    const cancelled = yield* store.cancel(accepted.id)
    const writeCancelled = yield* store.beginWriting(accepted.id)
    const repeatedCancellation = yield* store.cancel(accepted.id)

    expect(cancelled.status).toBe("cancelled")
    expect(writeCancelled).toBe(false)
    expect(repeatedCancellation.status).toBe("cancelled")

    const writing = yield* store.accept({ id: "already-writing", tenantId: "acme", request })
    const writeStarted = yield* store.beginWriting(writing.id)
    const rejected = yield* pipe(store.cancel(writing.id), Effect.result)

    expect(writeStarted).toBe(true)

    expect(rejected).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ReportExportCancellationRejected", status: "writing" },
    })
  }), Effect.provide(storeLayer))
}, Effect.scoped, Effect.provide(BunServices.layer)))

it.effect("writes artifacts idempotently and rejects conflicting content", Effect.fn("ReportExports.artifactIdempotency")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fileSystem.makeTempDirectoryScoped()
  const output = Layer.succeed(ReportArtifactOutput, { directory })
  const request = yield* requestEffect
  const job = makeReportExportJob(request, "immutable-artifact", null)
  const write = pipe(writeReportArtifact(job), Effect.provide(output))
  const first = yield* write
  const repeated = yield* write

  expect(repeated).toEqual(first)

  yield* fileSystem.remove(first.artifactPath)

  const reconciled = yield* write

  expect(reconciled).toEqual(first)

  const artifactPath = path.join(directory, "immutable-artifact.json")

  yield* fileSystem.writeFileString(artifactPath, "corrupted\n")

  const conflict = yield* pipe(write, Effect.result)

  expect(conflict).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ReportArtifactConflict", path: first.artifactPath },
  })
}, Effect.scoped, Effect.provide(BunServices.layer)))

it.effect("keeps privileged report-export audit evidence durable, idempotent, and authorized", Effect.fn(
  "ReportExports.audit",
)(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fileSystem.makeTempDirectoryScoped()
  const databasePath = path.join(directory, "report-export-audit.sqlite")

  const databaseLayer = SqliteBunRuntime.sqlClient(databasePath, {
    migrations: ReportExportMigrations,
  })

  yield* pipe(
    Effect.gen(function* () {
      yield* Application.prepare(ReportExportsApplication)
      yield* appendReportExportAudit({ action: "release", actorId: "admin", targetId: "export-1" })
      yield* appendReportExportAudit({ action: "resume", actorId: "admin", targetId: "export-1" })
      yield* appendReportExportAudit({ action: "cancel", actorId: "admin", targetId: "export-1" })
      yield* appendReportExportAudit({ action: "reconcile", actorId: "admin", targetId: "export-1" })
      yield* appendReportExportAudit({ action: "cancel", actorId: "admin", targetId: "export-1" })

      const sql = yield* SqlClient.SqlClient

      const rollback = pipe(
        appendReportExportAudit({ action: "cancel", actorId: "admin", targetId: "rolled-back-export" }),
        Effect.flatMap(() => Effect.fail("rollback")),
      )

      const transaction = sql.withTransaction(rollback)
      const rolledBack = yield* pipe(transaction, Effect.result)
      expect(rolledBack._tag).toBe("Failure")

      const client = yield* RpcTest.makeClient(reportAuditCommands.group)
      const readerSession = yield* sessionFor("bob")
      const adminSession = yield* sessionFor("admin")

      const anonymous = yield* pipe(
        client["ReportExport.AuditTrail"]({ executionId: "export-1" }),
        Effect.result,
      )

      expect(anonymous).toMatchObject({ _tag: "Failure", failure: { _tag: "Unauthenticated" } })

      const denied = yield* pipe(
        client["ReportExport.AuditTrail"]({ executionId: "export-1" }, { headers: readerSession }),
        Effect.result,
      )

      expect(denied).toMatchObject({ _tag: "Failure", failure: { _tag: "Forbidden" } })

      const audit = yield* client["ReportExport.AuditTrail"](
        { executionId: "export-1" },
        { headers: adminSession },
      )

      const actions = Array.map(audit, Struct.get("action"))
      const observedActions = HashSet.fromIterable(actions)
      const expectedActions = HashSet.make("release", "resume", "cancel", "reconcile")
      expect(observedActions).toEqual(expectedActions)

      const absent = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM report_export_audits WHERE targetId = 'rolled-back-export'`

      expect(absent).toEqual([{ count: 0 }])
    }),
    Effect.provide(reportAuditCommands.handlers),
    Effect.provide(AuthorizationRpc.layer),
    Effect.provide(TestIdentity),
    Effect.provide(databaseLayer),
  )


  const persisted = yield* pipe(
    Effect.gen(function* () {
      yield* Application.prepare(ReportExportsApplication)
      const sql = yield* SqlClient.SqlClient

      return yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM report_export_audits WHERE targetId = 'export-1'`

    }),
    Effect.provide(databaseLayer),
  )

  expect(persisted).toEqual([{ count: 4 }])
}, Effect.scoped, Effect.provide(BunServices.layer)))
