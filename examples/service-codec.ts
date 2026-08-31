import { mkdtempDisposableSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Context,
  Effect,
  Layer,
  pipe,
  Schema,
  SchemaGetter,
} from "effect"
import { Domain, Query, Table } from "effect-domains"
import * as SqliteBun from "effect-domains/sqlite-bun"

class StoragePrefix extends Context.Service<StoragePrefix, {
  readonly value: string
}>()("examples/StoragePrefix") {}

const StoredText = pipe(
  Schema.String,
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transformOrFail<string, string, StoragePrefix>(
      Effect.fn("StoredText.decode")(function* (value) {
        const prefix = yield* StoragePrefix
        return value.slice(prefix.value.length)
      }),
    ),
    encode: SchemaGetter.transformOrFail<string, string, StoragePrefix>(
      Effect.fn("StoredText.encode")(function* (value) {
        const prefix = yield* StoragePrefix
        return `${prefix.value}${value}`
      }),
    ),
  }),
)

const NoteId = pipe(Schema.String, Domain.identifier)
const Note = Schema.Struct({ id: NoteId, text: StoredText })
const Notes = Table.make(Note, { name: "notes" })

const CreateNote = Query.make(Notes, {
  Request: Note,
  Result: Note,
  implementation: Effect.fn("CreateNote.implementation")(function* (note) {
    const db = yield* SqliteBun.Database
    const rows = yield* db<Readonly<Record<string, unknown>>>`
      INSERT INTO ${db(Notes.name)} ${db.insert(note)} RETURNING *
    `
    return rows[0]
  }),
})

const createKeepsCodecRequirement = true satisfies (
  Context.Service.Identifier<typeof StoragePrefix> extends Effect.Services<
    ReturnType<typeof CreateNote.execute>
  > ? true : false
)

const temporaryDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempDisposableSync(join(tmpdir(), "effect-domains-codec-"))),
  (directory) => Effect.sync(() => directory.remove()),
)

const PrefixLive = Layer.succeed(StoragePrefix, { value: "stored:" })

const program = Effect.gen(function* () {
  const directory = yield* temporaryDirectory
  const DatabaseLive = SqliteBun.layer(
    new SqliteBun.SqliteBunOptions(join(directory.path, "example.sqlite")),
  )

  const operations = Effect.gen(function* () {
    yield* Notes.createTable()
    const id = Schema.decodeUnknownSync(NoteId)("note-1")
    return yield* CreateNote.execute({ id, text: "visible domain text" })
  })

  const result = yield* pipe(
    operations,
    Effect.provide(DatabaseLive),
    Effect.provide(PrefixLive),
  )

  yield* Effect.log("Codec requirement preserved", {
    createKeepsCodecRequirement,
    result,
  })
})

await pipe(program, Effect.scoped, Effect.runPromise)
