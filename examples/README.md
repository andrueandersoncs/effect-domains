# Examples

These examples use `Table.make` and one-operation `Query.make` definitions with the Bun SQLite adapter. Table creation is mechanically derived, while query behavior is authored as Effects.

Run them from the repository root:

```bash
bun run examples/basic-crud.ts
bun run examples/service-codec.ts
```

- [`basic-crud.ts`](basic-crud.ts) derives a `Book` table and authors create and find queries against a temporary SQLite database.
- [`service-codec.ts`](service-codec.ts) proves that a schema codec’s Effect service remains in an authored query’s execution requirements.

Each example supplies `SqliteBun.Database` only when the query program runs. The temporary database directory is removed afterward.
