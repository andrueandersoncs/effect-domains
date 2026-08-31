# Domain Identifier and Basic Persistence Direction

The initial persistence API should include only the basics.

- Do not add configurable database column mappings.
- Annotate an entity field schema directly with domain identity.
- Persistence derives its primary key from that identity annotation instead of requiring `primaryKey: "id"` configuration.
- Keep the persistence declaration to the entity schema and table name.

The accepted public shape uses `Domain.identifier` for intrinsic domain identity. Persistence requires exactly one such field and uses encoded schema field names directly as database column names.
