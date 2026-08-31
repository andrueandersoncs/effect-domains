import { mkdtempDisposableSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Array,
  Context,
  Effect,
  Layer,
  Option,
  pipe,
  Schema,
  SchemaGetter,
} from "effect"
import { Domain, Query, Table } from "effect-domains"
import * as SqliteBun from "effect-domains/sqlite-bun"

class StoragePrefix extends Context.Service<StoragePrefix, {
  readonly value: string
}>()("examples/StoragePrefix") {}

const decodeStoredText = SchemaGetter.transformOrFail<string, string, StoragePrefix>(
  Effect.fn("StoredText.decode")(function* (value) {
    const prefix = yield* StoragePrefix
    return value.slice(prefix.value.length)
  }),
)

const encodeStoredText = SchemaGetter.transformOrFail<string, string, StoragePrefix>(
  Effect.fn("StoredText.encode")(function* (value) {
    const prefix = yield* StoragePrefix
    return `${prefix.value}${value}`
  }),
)

const StoredTextSchema = pipe(
  Schema.String,
  Schema.decodeTo(Schema.String, {
    decode: decodeStoredText,
    encode: encodeStoredText,
  }),
)

// StoredText names the decoded value because its stored encoding requires a runtime service.
type StoredText = Schema.Schema.Type<typeof StoredTextSchema>

const NoteIdSchema = pipe(Schema.String, Domain.identifier)

// The decoded NoteId type stays distinct because note identifiers have independent domain semantics.
type NoteId = Schema.Schema.Type<typeof NoteIdSchema>

const NoteSchema = Schema.Struct({ id: NoteIdSchema, text: StoredTextSchema })

// Note names its decoded domain value because its text encoding evolves independently from other records.
interface Note extends Schema.Schema.Type<typeof NoteSchema> {}

const Notes = Table.make(NoteSchema, { name: "notes" })

const CreateNote = Query.make(Notes, {
  Request: NoteSchema,
  Result: NoteSchema,
  implementation: Effect.fn("CreateNote.implementation")(function* (note) {
    const db = yield* SqliteBun.Database

    const rows = yield* db<Readonly<Record<string, unknown>>>`
      INSERT INTO ${db(Notes.name)} ${db.insert(note)} RETURNING *
    `

    const firstRow = Array.get(rows, 0)
    return Option.getOrUndefined(firstRow)
  }),
})

const createKeepsCodecRequirement = true satisfies (
  Context.Service.Identifier<typeof StoragePrefix> extends Effect.Services<
    ReturnType<typeof CreateNote.execute>
  > ? true : false
)

const systemTemporaryDirectory = tmpdir()
const temporaryDirectoryPrefix = join(systemTemporaryDirectory, "effect-domains-codec-")

const acquireTemporaryDirectory = Effect.sync(
  () => mkdtempDisposableSync(temporaryDirectoryPrefix),
)

const makeCodecRemove = (
  directory: ReturnType<typeof mkdtempDisposableSync>,
) => Effect.sync(directory.remove)

const temporaryDirectory = Effect.acquireRelease(
  acquireTemporaryDirectory,
  makeCodecRemove,
)

const PrefixLive = Layer.succeed(StoragePrefix, { value: "stored:" })

const program = Effect.gen(function* () {
  const directory = yield* temporaryDirectory
  const databasePath = join(directory.path, "example.sqlite")
  const databaseOptions = new SqliteBun.SqliteBunOptions(databasePath)
  const DatabaseLive = SqliteBun.layer(databaseOptions)

  const operations = Effect.gen(function* () {
    yield* Notes.createTable()

    const id = NoteIdSchema.make("note-1")
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
