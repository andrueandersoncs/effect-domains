import { BunFileSystem } from "@effect/platform-bun"
import { join } from "node:path"
import { Array, Effect, FileSystem, pipe, Schema } from "effect"
import { SchemaStore } from "effect-domains/migrations"
import { Resource } from "effect-domains/resource"
import { SqliteBunRuntime } from "effect-domains/sqlite-bun"
import {
  SqliteBackfill,
  SqliteMigrations,
  SqliteRename,
  SqliteSchemaSnapshot,
} from "effect-domains/sqlite-migrations"

const DocumentV1Schema = Schema.Struct({
  title: Schema.NonEmptyString,
})

interface DocumentV1 extends Schema.Schema.Type<typeof DocumentV1Schema> {}

const DocumentsV1 = Resource.make({
  name: "documents",
  schema: DocumentV1Schema,
  operations: [],
})

const NonNegativePrioritySchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
)

const DocumentV2Schema = Schema.Struct({
  heading: Schema.NonEmptyString,
  summary: Schema.NullOr(Schema.String),
  priority: NonNegativePrioritySchema,
})

interface DocumentV2 extends Schema.Schema.Type<typeof DocumentV2Schema> {}

const DocumentsV2 = Resource.make({
  name: "documents",
  schema: DocumentV2Schema,
  operations: [],
})

const empty = SqliteSchemaSnapshot.make({ version: 1, tables: [] })
const versionOne = SqliteMigrations.snapshot([DocumentsV1.table])
const versionTwo = SqliteMigrations.snapshot([DocumentsV2.table])

const initial = SqliteMigrations.plan({
  id: "001_initial",
  from: empty,
  to: versionOne,
})

const unresolved = SqliteMigrations.plan({
  id: "002_document_metadata",
  from: versionOne,
  to: versionTwo,
})

const renameTitle = SqliteRename.make({
  table: "documents",
  from: "title",
  to: "heading",
})

const backfillPriority = SqliteBackfill.make({
  table: "documents",
  column: "priority",
  value: 0,
})

const reviewed = SqliteMigrations.plan({
  id: "002_document_metadata",
  from: versionOne,
  to: versionTwo,
  renames: [renameTitle],
  backfills: [backfillPriority],
})

const summarizeStep = (step: (typeof unresolved.steps)[number]) =>
  "reason" in step ? `${step._tag}: ${step.reason}` : step._tag

const unresolvedSteps = Array.map(unresolved.steps, summarizeStep)
const reviewedSteps = Array.map(reviewed.steps, summarizeStep)

await pipe(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "effect-domains-migration-lifecycle-",
    })

    const databasePath = join(directory, "example.sqlite")

    const versionOneRuntime = SqliteBunRuntime.sqlClient(databasePath, {
      migrations: [initial],
    })

    const createDocument = Effect.gen(function* () {
      const store = yield* SchemaStore
      yield* store.prepare(versionOne.tables)
      return yield* DocumentsV1.repository.create({ title: "Migration guide" })
    })

    const created = yield* pipe(
      createDocument,
      Effect.provide(versionOneRuntime),
    )

    const versionTwoRuntime = SqliteBunRuntime.sqlClient(databasePath, {
      migrations: [initial, reviewed],
    })

    const loadMigratedDocument = Effect.gen(function* () {
      const store = yield* SchemaStore
      yield* store.prepare(versionTwo.tables)
      return yield* DocumentsV2.repository.get(created.id)
    })

    const migrated = yield* pipe(
      loadMigratedDocument,
      Effect.provide(versionTwoRuntime),
    )

    yield* Effect.log("Unresolved migration steps", unresolvedSteps)
    yield* Effect.log("Reviewed migration steps", reviewedSteps)
    yield* Effect.log("Migrated document", migrated)
  }),
  Effect.scoped,
  Effect.provide(BunFileSystem.layer),
  Effect.runPromise,
)
