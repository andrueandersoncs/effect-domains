# Effect Domains

Effect Domains derives mechanical, lossless application capabilities from canonical Effect Schemas while keeping business and infrastructure semantics explicit.

Persistence is the first implemented capability. A declarative sidecar catalog compiles into typed full-CRUD Effect programs. Runtime Layers supply concrete database implementations.

## Declarative Persistence

```ts
import { Effect, Option, Schema } from "effect"
import {
  compilePersistenceCatalog,
  definePersistenceCatalog,
} from "effect-domains"
import * as SqliteBun from "effect-domains/sqlite-bun"

const UserId = Schema.String.pipe(Schema.brand("UserId"))
const User = Schema.Struct({
  id: UserId,
  displayName: Schema.String,
  score: Schema.Number,
})

const catalog = definePersistenceCatalog({
  users: {
    schema: User,
    table: "users",
    primaryKey: "id",
    columns: { displayName: "display_name" },
  },
})

const persistence = Effect.runSync(compilePersistenceCatalog(catalog))

const program = Effect.gen(function* () {
  const created = yield* persistence.users.create({
    id: Schema.decodeUnknownSync(UserId)("user-1"),
    displayName: "Ada",
    score: 1,
  })
  const found = yield* persistence.users.read(created.id)
  const updated = yield* persistence.users.update({
    ...created,
    displayName: "Ada Lovelace",
  })
  const deleted = yield* persistence.users.delete(created.id)

  return { found, updated, deleted }
})

const Live = SqliteBun.layer(persistence, { filename: "app.sqlite" })
await Effect.runPromise(program.pipe(Effect.provide(Live)))
```

The database table must already exist. Migrations and table creation remain explicit application concerns.

### Supported declarations

The first release supports canonical `Schema.Struct` values that encode to flat, required, string-named fields. Each encoded field must be a `String` or `Number` scalar. Brands, checks, and transformations are supported when their encoded side meets that shape. The original schema codec performs every write encoding and read decoding, including any Effect service requirements.

A declaration supplies only:

- the canonical schema;
- the table name;
- one caller-supplied primary-key field; and
- optional column renames.

### CRUD semantics

- `create(entity)` inserts and returns the complete decoded entity.
- `read(key)` returns `Option<Entity>`.
- `update(entity)` replaces every non-key field and returns `Option<Entity>`.
- `delete(key)` is idempotent and returns whether a row existed.

The first release does not provide migrations, table creation, relationships, indexes, generated IDs or defaults, partial updates, arbitrary queries, transactions, authorization, or business policy.

## Documentation

The persistent project wiki starts at [docs/wiki/README.md](docs/wiki/README.md). See [Persistence Catalog](docs/wiki/persistence-catalog.md) for the accepted design and implementation evidence.

## Development

```bash
bun install
bun run check
bun test
```
