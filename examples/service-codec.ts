import { mkdtempDisposableSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Array,
  Context,
  Effect,
  Function,
  Layer,
  Option,
  pipe,
  Schema,
  SchemaGetter,
} from "effect"
import { identifier } from "effect-domains/domain"
import { Query } from "effect-domains/query"
import { Database, SqliteBunRuntime } from "effect-domains/sqlite-bun"
import { Table } from "effect-domains/table"

await pipe(
  Effect.gen(function* () {
    class StoragePrefix extends Context.Service<StoragePrefix, {
      readonly value: string
    }>()("examples/StoragePrefix") {}

    const decodeStoredText = SchemaGetter.transformOrFail<
      string,
      string,
      StoragePrefix
    >(Effect.fn("StoredText.decode")(function* (value) {
      const prefix = yield* StoragePrefix

      return value.slice(prefix.value.length)
    }))

    const encodeStoredText = SchemaGetter.transformOrFail<
      string,
      string,
      StoragePrefix
    >(Effect.fn("StoredText.encode")(function* (value) {
      const prefix = yield* StoragePrefix

      return `${prefix.value}${value}`
    }))

    const StoredTextSchema = pipe(
      Schema.String,
      Schema.decodeTo(Schema.String, {
        decode: decodeStoredText,
        encode: encodeStoredText,
      }),
    )

    const NoteIdSchema = pipe(
      Schema.String,
      Schema.brand("NoteId"),
      identifier,
    )

    const NoteFields = Function.identity({
      id: NoteIdSchema,
      text: StoredTextSchema,
    })

    const NoteSchema = pipe(NoteFields, Schema.Struct)
    const Notes = Table.make({ name: "notes", schema: NoteSchema })

    const createNote = Effect.fn("CreateNote.implementation")(function* (
      note: typeof NoteSchema.Encoded,
    ) {
      const database = yield* Database

      const rows = yield* database<Readonly<Record<string, unknown>>>`
        INSERT INTO ${database(Notes.name)} ${database.insert(note)} RETURNING *
      `

      return pipe(rows, Array.get(0), Option.getOrUndefined)
    })

    const CreateNote = Query.make({
      table: Notes,
      Request: NoteSchema,
      Result: NoteSchema,
      implementation: createNote,
    })

    const createKeepsCodecRequirement = true satisfies (
      Context.Service.Identifier<typeof StoragePrefix> extends Effect.Services<
        ReturnType<typeof CreateNote.execute>
      > ? true : false
    )

    const systemTemporaryDirectory = tmpdir()

    const temporaryDirectoryPrefix = join(
      systemTemporaryDirectory,
      "effect-domains-codec-",
    )

    const acquireTemporaryDirectory = Effect.sync(
      () => mkdtempDisposableSync(temporaryDirectoryPrefix),
    )

    const removeFromMkdtempdisposablesync = (
      directory: ReturnType<typeof mkdtempDisposableSync>,
    ) => Effect.sync(directory.remove)

    const PrefixLive = Layer.succeed(StoragePrefix, { value: "stored:" })

    const directory = yield* Effect.acquireRelease(
      acquireTemporaryDirectory,
      removeFromMkdtempdisposablesync,
    )

    const databasePath = join(directory.path, "example.sqlite")
    const databaseLayer = SqliteBunRuntime.sqlClient(databasePath)

    const operations = Effect.gen(function* () {
      yield* Notes.write()

      const id = NoteIdSchema.make("note-1")

      return yield* CreateNote.execute({
        id,
        text: "visible domain text",
      })
    })

    const result = yield* pipe(
      operations,
      Effect.provide(databaseLayer),
      Effect.provide(PrefixLive),
    )

    yield* Effect.log("Codec requirement preserved", {
      createKeepsCodecRequirement,
      result,
    })
  }),
  Effect.scoped,
  Effect.runPromise,
)
