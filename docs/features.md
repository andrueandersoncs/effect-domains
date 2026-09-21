---
description: Complete list of features implemented in the current Effect Domains workspace.
---

# Implemented features

## Domain schemas and storage

- Canonical domain models defined with Effect Schema.
- Shared UUIDv7, Gregorian calendar-date, safe-integer, positive-integer, non-negative-integer, and page-limit schemas.
- Intrinsic domain identifiers declared with the `identifier` annotation.
- Persistence-only UUIDv7 identifiers generated when a domain schema has no intrinsic identifier.
- Separate canonical and physical storage schemas with reversible field codecs.
- Effect service requirements preserved through storage encoding and decoding.
- SQLite storage for strings, integers, real numbers, booleans, UTC timestamps, literals, enums, and nullable scalar values.
- SQLite column names derived from encoded schema field names.
- SQLite primary keys, nullability, scalar type checks, numeric bounds, enum checks, and Boolean `0`/`1` checks derived from schemas.
- Suspended scalar schemas and explicit scalar transformations supported by the table compiler.
- Composite unique constraints, composite foreign keys, scoped foreign keys, and secondary indexes.
- Automatic relation names with explicit-name overrides.
- Full-graph validation of tables, relations, foreign-key targets, and index names.
- Typed table snapshots for migration and inspection metadata.
- Typed table references and selected-field projections for authored SQL.
- JSON object projection fragments and codecs derived from selected table fields.

## Resources and repositories

- Declarative `Resource.define` specifications separated from compiled runtime products.
- `Resource.compile` derivation of tables, repositories, RPC contracts, handlers, publication metadata, and runtime schemas.
- Narrow access to a resource's compiled table and repository.
- Selectable `get`, `list`, `create`, `update`, `remove`, `patch`, and `transition` capabilities.
- One-call CRUD capability declaration.
- Local repository methods available independently of RPC publication.
- Optional suppression of published create and list operations while retaining local behavior.
- Typed `find`, `get`, `list`, `create`, `ensure`, `update`, `patch`, `remove`, and `transition` repository operations.
- Idempotent repository seeding with `ensure`.
- Creation fields sourced from caller input, constant defaults, generated UUIDv7 values, generated current timestamps, or authenticated subject fields.
- Implicit `null` defaults for otherwise-unassigned nullable creation fields.
- Complete-row validation on creation and replacement.
- Transactional patch merging with identifier preservation.
- Declarative optimistic-version fields with automatic initial values, increments, expected-version checks, and `VersionConflict` failures.
- Declarative status-transition graphs with derived action schemas, guards, conditional writes, and transition failures.
- Equality-filtered resource lists.
- Inclusive range-filtered resource lists.
- Fixed ascending and descending list ordering with stable identifier tie-breaking.
- Configurable bounded page sizes.
- Opaque keyset cursors tied to the original filter, range, and ordering state.
- Shared bounded `{ items, nextCursor }` page contracts.
- Client-side page accumulation, replacement, continuation, and stale-response protection primitives.
- Typed `ResourceNotFound`, `RepositoryError`, `UniqueViolation`, and `VersionConflict` failures.
- Repository transactions shared with authored Effect SQL on the same SQLite connection.

## Authorization, identity, and entitlements

- Explicit public, deny-all, and typed policy authorization modes.
- Closed policy expressions over subject, current-row, and candidate-row fields.
- Total scalar equality, collection membership, conjunction, and disjunction policy operations.
- Mandatory row scope combined with per-action rules.
- Distinct read, create, update, patch, remove, and transition authorization rules.
- Reusable subject-only policies.
- SQL compilation of row-visibility policy before list pagination.
- In-memory policy evaluation for mutation candidates and standalone checks.
- Hidden-row behavior that returns not-found rather than disclosing inaccessible records.
- Transactional authorization checks around writes and returned rows.
- Trusted subject-to-create-field bindings.
- Request-local bearer authentication for protected RPCs.
- Typed `Unauthenticated` and `Forbidden` failures.
- Portable credential, issued-session, current-session, subject, and identity-runtime contracts.
- Native `identity.login`, `identity.current`, and `identity.logout` RPCs.
- SQLite identity implementation with Argon2id password verification.
- Random opaque session tokens stored only as SHA-256 digests.
- Expiring and revocable sessions checked against current account state on every authenticated call.
- Separate private identity databases with application-database path and inode collision protection.
- Declarative entitlement requirements attached to authorization policies.
- Typed table-backed entitlement sources with subject-to-storage scope bindings.
- Closed entitlement grant expressions over row values, literals, current time, equality, ordering, conjunction, and disjunction.
- Fresh persisted entitlement evaluation on every check.
- Distinct `EntitlementRequired` and `EntitlementUnavailable` failures.

## Commands, read models, applications, and flags

- Declarative command contracts separated from authored Effect implementations.
- Command payload, success, declared-error, unavailable-error, authorization, transaction, and dependency declarations.
- Command families with shared namespaces, unavailable boundaries, authorization policies, and transaction modes.
- Automatic canonical JSON RPC codecs for command inputs and outputs.
- Automatic authorization and transaction wrapping for commands.
- Translation of undeclared infrastructure failures to declared unavailable failures.
- Bundling of authored commands into RPC groups and handler layers.
- Exact command dependencies on resources, tables, and read models.
- Declarative read models over named table and resource sources.
- Explicit inner and left equality joins.
- Recursive schema-backed field selection.
- Derived joined schemas, storage codecs, SQL metadata, dependencies, and inspection descriptions.
- Bounded read-model pages with equality filters, inclusive ranges, fixed ordering, and keyset cursors.
- Publication of read-model pages as typed commands without restating their contracts.
- Shared read-model fold and map operations for additional interpreters.
- Native Effect RPC bundles as an escape hatch for infrastructure-specific operations.
- Explicit application parts for resources, commands, native RPCs, feature flags, and nested applications.
- Recursive nested-application flattening into one authoritative `ApplicationIR`.
- Cross-sibling resource relations and command dependencies validated after complete-tree composition.
- Duplicate table, RPC, command, and feature-flag rejection.
- One compiled application IR consumed by runtime, CLI, MCP, inspection, telemetry, and Application UI adapters.
- JSON inspection of operation schemas, middleware errors, resources, creation policy, list policy, versions, transitions, authorization, storage, physical tables, commands, and feature flags.
- Immutable feature-flag declarations with name, default value, and optional description.
- Exact-descriptor feature-flag registration across nested applications.
- Narrow feature-flag service with reads, writes, enable, disable, and atomic toggle operations.
- Process-local in-memory feature-flag layer with validated initial overrides.

## SQLite runtime and migrations

- Shared SQLite repository and migration implementation for Bun and Node drivers.
- SQLite foreign-key enforcement on every runtime connection.
- Application database directory creation.
- Private purpose-specific SQLite clients selected by environment or explicit filename.
- Physical repository access through a narrow runtime-provided service.
- Explicit version-2 SQLite migration artifacts.
- Fresh-schema migration derivation from compiled tables.
- Ordered imported migration-history decoding and validation.
- Create-table, add-column, rename-column, rebuild-table, create-index, and drop-index steps.
- Rebuild copies from source columns, constant values, or authored SQL expressions.
- Immutable applied-migration ledger with canonical artifact comparison.
- Transactional migration application and ledger updates.
- Rollback of failed schema changes or invalid copied rows.
- Exact table, column, index, and foreign-key drift verification before and after migration.
- Rejection of untracked SQLite objects and altered applied history.
- Verification that supplied history ends at the application's compiled schema.

## Runtime, transports, CLI, MCP, and Application UI

- Portable application runtime for service construction, initialization, background layers, and HTTP assembly.
- Bun application runner with typed Effect requirements and failures.
- `serve`, `worker`, `inspect`, operation-specific inspection, help, and generated remote-operation commands.
- Environment-derived application database, remote RPC URL, bearer token, identity database, and execution database settings.
- Optional startup initialization and background worker layers.
- Optional native HTTP route composition.
- Effect HTTP RPC publication with configurable path.
- Streamable HTTP MCP publication with configurable path.
- Generated CLI commands for every published unary RPC.
- Canonical `--input-json` CLI input and JSON stdout results.
- Schema-derived omission of no-payload, empty-struct, and all-optional CLI inputs.
- One MCP tool per published RPC with generated JSON schemas and structured results.
- Request-isolated in-process RPC transport for MCP and the Application UI.
- Preservation of RPC middleware, service-dependent codecs, declared failures, and request-local authentication in local clients.
- Prebuilt generated Application UI with configurable mount path.
- Generated operation navigation and forms from application inspection.
- Generated resource lists, equality filters, bounded pages, and cursor navigation.
- Complete-JSON input for operation shapes that are not rendered as field forms.
- Display-only application and resource titles, descriptions, labels, and columns.
- In-memory browser bearer-token handling with automatic login capture and logout clearing.
- Exact-origin checks for non-loopback Application UI calls.
- Static asset loading without runtime compilation.
- Loopback-only Bun HTTP binding.

## OpenTelemetry and operations

- Declarative OTLP trace, metric, and log export configuration.
- OTLP HTTP/protobuf and HTTP/JSON transports.
- Shared resource identity across server, CLI, initialization, worker, and browser signals.
- Explicit and standard OpenTelemetry environment-variable configuration with deterministic precedence.
- Per-signal endpoints, protocols, headers, batching, export intervals, and shutdown timeouts.
- Root trace sampling with parent sampling preserved.
- Effect fiber runtime metrics when metric export is enabled.
- Safe HTTP server, RPC server, and browser RPC duration histograms.
- Bounded failure attributes and logical operation names.
- Suppression of raw URL, query, header, payload, result, form, token, and SQL-bind capture in framework telemetry.
- Same-origin browser OTLP gateway with per-signal routes.
- Browser gateway body-size, content-type, origin, compression, and per-address rate enforcement.
- Server-side collector credentials that are never exposed to the browser.
- Browser page-load, RPC, validation, request-failure, uncaught-error, and unhandled-rejection signals.
- Transient exporter retries, `Retry-After` handling, temporary circuit breaking, and bounded shutdown flushing.
- Complete automatic-telemetry opt-out.
- Local Collector, Prometheus, Tempo, Loki, and Grafana observability stack.
- Prometheus alert-rule tests and a hardened production Collector example.

## Infrastructure and deployment

- Closed provider-neutral infrastructure declaration language.
- HTTP, background, and scheduled runtime declarations.
- SQLite store declarations with transaction semantics, durability, writer topology, lifecycle, and backup schedules.
- Durable-filesystem, object-store, at-least-once queue, secret, variable, public-endpoint, custom-domain, OTLP-destination, and extension declarations.
- Exact read/write database, object-store, queue, secret, variable, and telemetry bindings.
- RPC, MCP, and Application UI publication declarations.
- Convenience derivation of a common SQLite HTTP application infrastructure graph.
- Stable canonical logical resource IDs.
- Dependency and capability graph compilation.
- Validation of names, IDs, descriptor identity, registrations, acyclicity, publication uniqueness, and route collisions.
- Generated-UI reserved-route collision detection.
- Canonical infrastructure inspection without handlers or credentials.
- Local Bun execution directly from compiled infrastructure IR.
- In-memory SQLite for ephemeral infrastructure and file-backed SQLite for persistent infrastructure.
- Shared portable Node runtime used by deployment backends.
- Alchemy Railway deployment plans with project, process service, mounted volume, and generated public domain.
- Alchemy Fly deployment plans with app, process service, mounted machine volume, and public IPv4 allocation.
- Process-scoped application runtime construction for Railway and Fly.
- Production retain-on-removal handling for persistent provider resources.
- Fly daily and weekly volume snapshot retention mapping.
- Provider capability validation for execution model, transaction semantics, writer topology, backups, storage, networking, telemetry, and extensions.
- Rejection of unsupported multi-writer deployments and unsupported Railway backup schedules.
- Rejection of production deployment with local-only Alchemy state.
- Cloudflare capability validation that rejects incompatible interactive-transaction applications.

## Native durable execution and synchronization examples

- Native Effect Cluster runtime integration without a framework workflow or actor DSL.
- Local single-runner, colocated HTTP runner, and client-only execution modes.
- Shared execution-store topology checks for version, shard count, and shard groups.
- Client-only worker-registration protection.
- Explicit compare-and-set topology upgrades.
- Application-owned transactional outbox with deterministic at-least-once workflow dispatch.
- Recoverable workflow suspension and explicit resume.
- Explicit workflow cancellation with terminal-state guards.
- Immutable idempotent artifact writes and artifact reconciliation.
- Typed SQL EventLog journal, remote replay, duplicate handling, projection rebuild, and deterministic replica conflict resolution.
- Atomic file replacement helper for example-owned artifacts.

## Runnable applications

- Reading List: generated CRUD, nullable fields, equality filters, cursor paging, browser UI, and full-stack trace continuity.
- Expense Ledger: integer minor-unit amounts, authored inclusive date-range queries, and per-currency category totals.
- Team Tasks: tenant and owner scoping, reusable subject policies, trusted identity fields, and completion locks.
- Field Notes: protected records, service-dependent encrypted body storage, and EventLog-based replica synchronization.
- Editorial Calendar: generated CRUD and frozen historical schema migrations.
- Equipment Register: generated MCP tools, official MCP SDK client, unique editable tags, relocation, retirement, and removal.
- Reservations: declared reservation transitions plus authored transactional stock accounting.
- Orders and Invoices: nested application composition, tenant-scoped composite relations, uniqueness, optimistic versions, order lines, invoices, payments, transitions, and multi-record transactions.
- Purchased Guides: tenant-visible guides with persisted per-user, per-resource entitlement grants.
- Repair Workshop: customer and optional-technician joined board with declared filters, ordering, arrays, pages, and foreign-key behavior.
- Support Cases: sibling domain applications, cross-child relations, joined case board, optimistic lifecycle transitions, on-duty assignment checks, nested event history, and transactional audit records.
- Report Exports: subscription-gated generation, approval waits, durable release/recovery/cancellation, outbox dispatch, immutable JSON artifacts, reconciliation, polling, audit history, and custom metrics.
- Appointment Reminders: persisted per-recipient scheduling, durable execution, deduplicated application inbox delivery, singleton projection, and retention work.
