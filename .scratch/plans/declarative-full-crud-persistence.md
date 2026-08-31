# Declarative Full-CRUD Persistence Plan

## Original Request

Plan the first complete Effect Domains persistence release approved in this conversation.

User direction, quoted exactly:
- “Well, my first desire/need is persistence.”
- “**all** implementations should use Effect and the principles of /skill:software-laws in order to program to **interfaces**”
- “I think it can still execute persistence operations (or both?) but just use Effect Context / Requirements to program to an interface requiring some arbitrary (runtime-provided) concrete database implementation right?”
- “okay so we want a focus on a **declarative** interface in our final user-facing product, they are not going to write functions or procedures but they will gladly write configurations/annotations/etc”
- “and this focus on declarative interfaces is not just specific to this task, it's a fundamental core principle of this project”
- Requested persistence scope: “full crud”
- The user approved the recommended compiled persistence catalog design and asked for the concrete verified implementation plan: “perfect, do it”

Approved design boundary:
- A sidecar catalog references canonical Effect Schema.Struct schemas and declares only persistence facts that cannot be derived: entity name/catalog key, table, primary-key field, and optional column renames.
- Compiling the catalog generates one narrow Context service requirement per entity plus generated create/read/update/delete Effect operations. Users do not author repositories, SQL, handlers, mapping callbacks, or concrete services on the normal path.
- create accepts and returns a complete entity with caller-supplied primary key.
- read by primary key returns Option<Entity>.
- update is complete replacement selected by the same primary key and returns Option<Entity>.
- delete by primary key is idempotent and returns whether a row existed.
- A runtime Layer supplies the concrete adapter. The first reference adapter is Bun SQLite using current official Effect SQL support.
- A reusable adapter contract proves the CRUD semantics.
- Keep migrations, table creation, relationships, indexes, generated IDs/defaults, partial updates, arbitrary queries, transactions, authorization, and business policy outside this first release.
- Keep canonical domain schemas persistence-free. Derive only mechanical/lossless mappings. Reject unsupported shapes on the normal path rather than adding speculative escape hatches to this release.
- Current verified Effect v4 constraints: pin the exact current Effect v4 RC; start with Schema.Struct and string-named fields; preserve schema EncodingServices/DecodingServices rather than casting them away; use public Schema/SchemaAST APIs only; inspect Schema.toEncoded/AST to validate supported row shape but execute original codecs with Schema.encodeEffect/decodeUnknownEffect; use Context.Service and Layer construction; hide effect/unstable/sql and @effect/sql-sqlite-bun behind the adapter package/module; do not use effect/unstable/persistence or persistence-aware unstable Model as the public design.
- The repository currently contains only Bun scaffold code and project wiki/instructions. Use Bun commands.

## Finalized Plan

1. **Turn the Bun scaffold into the first package surface.**
   - Update `package.json` and `bun.lock` with exact, non-range runtime dependencies `effect@4.0.0-rc.112` and `@effect/sql-sqlite-bun@4.0.0-rc.112`.
   - Set the initial package version and add only the public root export, the `./sqlite-bun` adapter subpath, `check` (`tsc --noEmit`), and `test` (`bun test`) scripts.
   - Replace the current hello-world `index.ts` with re-exports of the database-neutral persistence API. Keep the Bun SQLite entry point separate so the root module never exposes or imports Effect SQL internals.

2. **Add the declarative catalog and compiler in `src/Persistence.ts`.**
   - Define `definePersistenceCatalog` as the typed sidecar declaration. Each catalog key is the entity name and each value contains exactly `schema`, `table`, `primaryKey`, and an optional partial `columns` rename map. Constrain `schema` to `Schema.Struct`, `primaryKey` and rename keys to its string field names, and infer entity and primary-key types from the schema.
   - Define `compilePersistenceCatalog` to inspect `Schema.toEncoded(schema).ast` through public `SchemaAST` guards and nodes. Accept the first release’s flat, required, string-named struct fields whose encoded values are SQLite-safe `String` or `Number` scalars, including branded/checked fields and transformations that encode to those scalars. Confirm that the primary key exists and that the effective column names are unique. Reject every other declaration during compilation with one catalog compilation error; do not add mapping callbacks or escape hatches.
   - Preserve the original schema and original primary-key field schema beside the inspected encoded metadata. Use `Schema.encodeEffect` and `Schema.decodeUnknownEffect` on those originals in executable operations so their `EncodingServices` and `DecodingServices` remain in the inferred Effect requirements.
   - For every compiled entity, create a distinct `Context.Service` for a narrow encoded-row store with `create`, `read`, `update`, and `delete` methods. Generate the domain-facing methods on the same compiled entity: `create(entity)` returns the complete entity, `read(primaryKey)` returns `Option<Entity>`, `update(entity)` performs complete replacement under the entity’s same key and returns `Option<Entity>`, and `delete(primaryKey)` returns `boolean`. These methods must only encode/decode, apply the mechanical field/column metadata, and call the generated service.
   - Add one public `PersistenceError` that adapters use for infrastructure failures. Generated operations expose only this error plus Effect Schema codec errors; no SQL error type enters the root API.

3. **Implement the reference adapter in `src/SqliteBun.ts`.**
   - Export `layer(compiledCatalog, { filename })`, returning a `Layer` that supplies every generated entity service and owns the scoped Bun SQLite client.
   - Keep all imports from `effect/unstable/sql` and `@effect/sql-sqlite-bun` in this module. Use the official `SqliteClient.layer`, Effect/Layer composition, escaped SQL identifiers, and bound values.
   - Implement the store methods directly from compiled metadata: `INSERT ... RETURNING *`; primary-key `SELECT ... LIMIT 1`; `UPDATE` of every non-key column with `RETURNING *`; and `DELETE ... RETURNING` of the primary key. Translate renamed database columns back to encoded schema field names before the compiler decodes rows. Convert empty result arrays to `Option.none` or `false`, and map Effect SQL failures to `PersistenceError`.
   - Do not create tables or add migration, query, transaction, relationship, index, generated-key, default, patch-update, authorization, or policy behavior.

4. **Add a reusable CRUD adapter contract in `test/adapterContract.ts`.**
   - Make the contract accept only a valid compiled fixture entity, its runtime adapter layer, and fixed create/replacement/missing-key values.
   - Run one sequential Effect program that proves all promised semantics: caller-supplied key creation and returned entity; `Some` read; full replacement and returned `Some`; missing-key read/update as `None`; first delete as `true`; post-delete read as `None`; and repeated delete as `false`.
   - Keep this contract database-neutral so every later adapter must pass the identical observable behavior.

5. **Exercise the compiler and Bun SQLite adapter end to end in `test/SqliteBun.test.ts`.**
   - Define a valid canonical `Schema.Struct` fixture with a branded caller-supplied identifier, a field codec whose encoded side is a supported scalar, and a renamed column. Include a codec that requires an Effect service and provide that service separately, proving the generated operation types and runtime programs retain codec requirements.
   - Declare and compile the catalog only through the public declarative API. Create the required table as test fixture setup in a temporary SQLite file, then run the shared adapter contract through `SqliteBun.layer`.
   - Add a small valid two-entity compiler assertion that the catalog emits separate service keys, proving the one-service-per-entity boundary without adding a second adapter or repository implementation.

6. **Document the shipped interface and evidence.**
   - Update `README.md` with the exact catalog/compile/operation/Layer usage, the supported encoded row shape, the pre-existing-table assumption, CRUD return semantics, and the explicit first-release exclusions.
   - Add `docs/wiki/persistence-catalog.md` as the accepted persistence decision and implementation-evidence page. Record what is declared, what is mechanically derived, the Context/Layer boundary, codec-service preservation, the adapter contract evidence, and why this release does not yet prove a general framework. Cite `raw/effect-and-declarative-interface-direction.md` and the thesis close to those claims.
   - Update `docs/wiki/README.md` to index the new page and reflect the implemented status. Update `docs/wiki/research-agenda.md` to move the resolved catalog, CRUD, service, and adapter-contract questions into established findings while leaving migrations and broader vertical-slice validation unresolved.

7. **Verify only the complete normal path.**
   - Run `bun install` to materialize the exact lockfile.
   - Run `bun run check` to verify catalog inference, generated Effect requirements, and public module boundaries.
   - Run `bun test` to execute the reusable contract against a real temporary Bun SQLite database and prove the documented CRUD behavior, column rename, original schema codecs, and runtime-provided services.

## Verification Verdict

APPROVED
