import { BunServices } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Schema, pipe } from "effect"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"

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

const executionStore = (filename: string) => {
  const tables = prepareTables([ReportExportExecutionsResource.table])
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
