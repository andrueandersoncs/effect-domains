import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Context,
  Effect,
  Layer,
  Schema,
  SchemaGetter,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import {
  compilePersistenceCatalog,
  definePersistenceCatalog,
} from "../index.ts"
import { layer as sqliteBunLayer } from "../src/SqliteBun.ts"
import { adapterContract } from "./adapterContract.ts"

const CodecPrefix = Context.Service<{ readonly prefix: string }>(
  "test/CodecPrefix",
)

const StoredString = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transformOrFail((value: string) =>
      CodecPrefix.use(({ prefix }) =>
        Effect.succeed(value.slice(prefix.length))
      )
    ),
    encode: SchemaGetter.transformOrFail((value: string) =>
      CodecPrefix.use(({ prefix }) => Effect.succeed(`${prefix}${value}`))
    ),
  }),
)

const UserId = Schema.String.pipe(Schema.brand("UserId"))
const User = Schema.Struct({
  id: UserId,
  displayName: Schema.String,
  secret: StoredString,
  score: Schema.Number,
})

const Catalog = definePersistenceCatalog({
  users: {
    schema: User,
    table: "users",
    primaryKey: "id",
    columns: { displayName: "display_name" },
  },
})

const Compiled = Effect.runSync(compilePersistenceCatalog(Catalog))
type CreateRequirements = Effect.Services<
  ReturnType<typeof Compiled.users.create>
>
type CodecPrefixRequirement = Context.Service.Identifier<typeof CodecPrefix>
const preservesCodecRequirement: CodecPrefixRequirement extends CreateRequirements
  ? true
  : false = true
void preservesCodecRequirement

const PrefixLive = Layer.succeed(CodecPrefix, { prefix: "stored:" })

const directories: Array<string> = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const makeDatabase = () => {
  const directory = mkdtempSync(join(tmpdir(), "effect-domains-"))
  directories.push(directory)
  return join(directory, "test.sqlite")
}

const setupTable = (filename: string) =>
  SqlClient.SqlClient.use((sql) =>
    Effect.asVoid(sql`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        secret TEXT NOT NULL,
        score REAL NOT NULL
      )
    `)
  ).pipe(Effect.provide(SqliteClient.layer({ filename })))

describe("Bun SQLite persistence", () => {
  test("runs the complete declarative CRUD contract", async () => {
    const filename = makeDatabase()
    await Effect.runPromise(setupTable(filename))

    const id = Schema.decodeUnknownSync(UserId)("user-1")
    const missingId = Schema.decodeUnknownSync(UserId)("missing")

    const contract = adapterContract(
      Compiled.users,
      sqliteBunLayer(Compiled, { filename }),
      {
        original: {
          id,
          displayName: "Ada",
          secret: "analytical-engine",
          score: 1,
        },
        replacement: {
          id,
          displayName: "Ada Lovelace",
          secret: "difference-engine",
          score: 2,
        },
        missingKey: missingId,
      },
    ).pipe(Effect.provide(PrefixLive))

    await Effect.runPromise(contract)
  })

  test("compiles a separate service for each declared entity", () => {
    const Other = Schema.Struct({ id: Schema.String, value: Schema.Number })
    const catalog = definePersistenceCatalog({
      first: { schema: Other, table: "first", primaryKey: "id" },
      second: { schema: Other, table: "second", primaryKey: "id" },
    })
    const compiled = Effect.runSync(compilePersistenceCatalog(catalog))

    expect(compiled.first.Service).not.toBe(compiled.second.Service)
  })
})
