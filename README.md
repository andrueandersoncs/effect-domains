# Effect Domains

Effect Domains derives mechanical, lossless application structure from canonical Effect Schemas while keeping authored behavior and runtime infrastructure explicit.

Persistence currently separates table definitions from query definitions:

- `Table.make(schema, config)` derives validated table metadata and fresh table creation.
- `Query.make(table, config)` defines one operation from request/result schemas and an authored Effect implementation.

## Tables and Queries

```ts
import { Effect, Schema } from "effect"
import { Domain, Query, Table } from "effect-domains"
import * as SqliteBun from "effect-domains/sqlite-bun"

const UserIdSchema = Schema.String.pipe(
  Schema.brand("UserId"),
  Domain.identifier,
)

const UserSchema = Schema.Struct({
  id: UserIdSchema,
  displayName: Schema.String,
})

const Users = Table.make(UserSchema, { name: "users" })

const FindUser = Query.make(Users, {
  Request: UserIdSchema,
  Result: Schema.OptionFromNullOr(UserSchema),
  implementation: (id) =>
    Effect.gen(function* () {
      const db = yield* SqliteBun.Database
      const rows = yield* db<Readonly<Record<string, unknown>>>`
        SELECT * FROM ${db(Users.name)}
        WHERE ${db(Users.identifier)} = ${id}
        LIMIT 1
      `
      return rows[0] ?? null
    }),
})

const Live = SqliteBun.layer(
  new SqliteBun.SqliteBunOptions("app.sqlite"),
)

const program = Effect.gen(function* () {
  yield* Users.createTable()
  return yield* FindUser.execute(
    Schema.decodeUnknownSync(UserIdSchema)("user-1"),
  )
})

await Effect.runPromise(program.pipe(Effect.provide(Live)))
```

`Query.make` performs only mechanical work: it encodes `Request`, runs `implementation`, and decodes `Result`. The implementation’s Effect requirement channel carries `SqliteBun.Database` until execution. Query config therefore has no database field and no CRUD/type discriminator.

## Supported Tables

`Table.make` currently accepts canonical `Schema.Struct` values that encode to flat, required, string-named fields. Encoded fields must be `String` or `Number`. Exactly one field must use `Domain.identifier`; its encoded name becomes the primary key column. Other encoded field names become column names.

`createTable()` derives a fresh physical table. Existing-table migrations remain explicit application concerns. Queries, including CRUD, are authored because their behavior is not mechanically present in an entity schema.

## Examples

Runnable examples are indexed in [`examples/README.md`](examples/README.md).

## Documentation

The persistent project wiki starts at [docs/wiki/README.md](docs/wiki/README.md). See [Tables and Queries](docs/wiki/tables-and-queries.md) for the accepted design and current evidence.

## Development

```bash
bun install
bun run check
bun run lint
bun test
```
