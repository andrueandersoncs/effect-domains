# Catalog Key and Table Direction

The basic persistence declaration should not repeat a table name or add a table annotation.

The catalog key is both the generated capability name and the SQL table name. A persistence declaration maps that key directly to its canonical schema:

```ts
Persistence.define({
  books: BookSchema,
})
```

A future case where capability and table names differ requires an explicit persistence transformation outside this basic API.
