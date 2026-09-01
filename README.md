# Effect Domains

Effect Domains derives mechanical, lossless application structure from canonical Effect Schemas while keeping authored behavior and runtime infrastructure explicit.

Persistence currently separates table definitions from query definitions:

- `Table.make(schema, config)` derives validated table metadata and fresh table creation.
- `Query.make(table, config)` defines one operation from request/result schemas and an authored Effect implementation.

## Tables and Queries

```ts
import { Array, Effect, Option, Schema } from "effect"
import { Query, Table } from "effect-domains"
import * as SqliteBun from "effect-domains/sqlite-bun"

const BookSchema = Schema.Struct({
  title: Schema.String,
  pageCount: Schema.Number,
})

const Books = Table.make(BookSchema, { name: "books" })

const CreateBook = Query.make(Books, {
  Request: BookSchema,
  Result: Books.rowSchema,
  implementation: Effect.fn("CreateBook.implementation")(function* (book) {
    const db = yield* SqliteBun.Database
    const rows = yield* db<Readonly<Record<string, unknown>>>`
      INSERT INTO ${db(Books.name)} ${db.insert(book)} RETURNING *
    `
    return Option.getOrUndefined(Array.get(rows, 0))
  }),
})

const Live = SqliteBun.layer(
  new SqliteBun.SqliteBunOptions("app.sqlite"),
)

const program = Effect.gen(function* () {
  yield* Books.createTable()
  return yield* CreateBook.execute({
    title: "A Field Guide",
    pageCount: 120,
  })
})

await Effect.runPromise(program.pipe(Effect.provide(Live)))
```

`Query.make` performs only mechanical work: it encodes `Request`, runs `implementation`, and decodes `Result`. The implementation’s Effect requirement channel carries `SqliteBun.Database` until execution. Query config therefore has no database field and no CRUD/type discriminator.

## Supported Tables

`Table.make` accepts canonical `Schema.Struct` values that encode to flat, required, string-named fields. Encoded fields must be `String` or `Number`. When the schema has no `Domain.identifier`, the table adds a generated UUIDv7 `id` primary-key column. `table.schema` remains the original domain schema, while `table.rowSchema` exposes the persisted row shape including that generated identifier.

A schema may instead mark one field with `Domain.identifier`. That field becomes the primary key and suppresses the generated `id`. An unannotated source field named `id` is rejected rather than overwritten.

`createTable()` derives a fresh physical table. The SQLite adapter generates fallback UUIDv7 values in the database. Existing-table migrations remain explicit application concerns. Queries, including CRUD, are authored because their behavior is not mechanically present in an entity schema.

## Examples

Runnable examples are indexed in [`examples/README.md`](examples/README.md).

## Documentation

The persistent project wiki starts at [docs/wiki/README.md](docs/wiki/README.md). See [Tables and Queries](docs/wiki/tables-and-queries.md) for the accepted design and current evidence.

## Development

```bash
bun install
bun run check
bun run lint
bun run test
```
