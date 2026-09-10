# better-typescript feedback from the schema/RPC refactor

Status: submitted as [better-typescript#8](https://github.com/andrueandersoncs/better-typescript/issues/8) on 2026-09-10. All existing lint rules remain enabled, with no suppressions. Workspace/root lint and typechecks pass; all 58 behavior tests pass.

Environment: better-typescript 0.4.14, TypeScript ^7, Effect 4.0.0-rc.112, Bun workspace on macOS arm64.

## Crash: cache-preference

Observed command: `bun run lint`. Isolated with `bunx better-typescript --files src/sqlite-migrations.ts` from `packages/effect-domains`.

Observed result: exit 2, Go nil-pointer panic rather than a diagnostic. Stack starts at `typescript-go/internal/ast.IsIdentifier`, then `cache_preference.keyFor` (rule.go:81), `dependsOnKey` (210), `computingValue` (242), rule visitor (353). The crash persists after TypeScript syntax errors elsewhere were repaired. A minimal reproducer is not yet isolated. Captured full output: `local://lint-sqlite-migrations.ts.txt`.

After replacing the mutable planner with schema-backed reconciliation and Effect collections, aggregate `bun run lint` no longer panicked and exposed 86 ordinary migration diagnostics. This is a correlation, not an isolated root cause.

## Diagnostic accuracy to investigate

- `unused-field` flags `ResourceOperations.list`, `.create`, and `CreationPolicy.publish` despite their roles in generic API constraints and publication selection. The runtime configuration is decoded through an Effect Schema; its decoded type and typed input constraint are different compiler views of the same contract. This may be a cross-view analysis limitation, not genuinely dead fields.
- `unused-field` also reports both `List.filter` and `ListPolicy.filter` at one declaration. Determine whether duplicate instantiated-type diagnostics should be deduplicated.
- `duplicate-shape` flags two local aliases of `Schema.Struct<Schema.Struct.Fields>` in different modules. Sharing one native-schema alias is possible; consider whether reporting native utility aliases improves the design.
- `function-derived-model` flags `CreateInput` and `PatchInput`. These types are schema-derived user-facing operation contracts, not independent runtime DTOs. The rule's instruction to remove/deepen them conflicts with making RPC input contracts explicit unless native RPC type derivation can replace them.

## Reproduced rule conflict: numeric conditional results

Minimal standalone source:

```ts
export const countSource = (count: number, present: boolean) => present ? count + 1 : count
```

Run `better-typescript --files repro.ts --rules require-result-shape-name-consistency`.
Observed exit 1: `countSource claims a number result via count, but returns unknown`.

Apply the diagnostic's proposed return annotation:

```ts
export const countSource = (count: number, present: boolean): number => present ? count + 1 : count
```

Run `better-typescript --files repro.ts --rules require-result-shape-name-consistency,prefer-inferred-types`.
Observed exit 1: `Avoid a return annotation when the function body infers the same type. Delete the return type annotation.`

Both commands were executed in a standalone temporary project with `strict: true`, `target: ES2022`, `module: ESNext`, and `moduleResolution: Bundler`. No Effect dependency is needed. The two recommendations conflict: result-name analysis reports unknown while inferred-type analysis recognizes number. The production reducer was named `accumulatePresence`, describing its reducer semantics without the rejected count prefix; no rule was disabled.

## Remediation observations

- Restoring typed configuration consumption reduced resource diagnostics from 153 to 4 while retaining shared authorization/transaction execution and schema-derived cursor validation. The earlier unused-field diagnostics disappeared without removing the public configuration fields.
- Renamed the private schema-derived `CreateInput`/`PatchInput` types to `ResourceDraft`/`ResourceChanges`; operation contracts and runtime validation remain unchanged.
- Shared the native struct-schema alias in `domain.ts` rather than keeping duplicate aliases.
- Closed schema interpreters require named adapters, intermediate bindings, Match dispatch, and Option conversions. These are deliberate style costs, distinct from the reproduced inference conflict above.

## Deliberate rules with measurable design cost

These are not asserted to be bugs; the user chose to preserve them.

- `no-nested-calls` flags declarative `Rpc.make(tag, { payload: Schema.toCodecJson(schema), ... })`, `Schema.Struct(Record.map(...))`, and `Effect.runSync(Effect.gen(...))`. Each requires intermediate bindings or data-last composition, even when the nested expressions directly describe a contract.
- `no-inline-closures` and `prefer-composed-callbacks` require named adapters for callbacks passed to local helpers, while permitting callbacks to third-party functions. This makes a project-owned abstraction more verbose to use than an equivalent library abstraction.
- `no-multiple-boolean-operators` and `no-inline-boolean-expressions` require separate names for conjunctions and simple guards. Record whether the introduced names explain policy or merely repeat syntax.
- `prefer-equivalence-strict-equal` requires a function call for primitive equality and discriminants; unlike `===`, that call does not supply TypeScript control-flow narrowing.
- `schema-record-interface` requires a named decoded interface even for intermediate schema construction that is consumed only by another schema. A generic schema-derived object can also be illegal as an interface base (TS2312), requiring a widened field view or a different declaration shape.

Initial scoped result for resource.ts: 153 diagnostics. Final `bun run lint` passes across every workspace and the root without changing rule configuration.

## Final footprint and integration observations

- Framework source changed from 6,903 lines / 286,991 bytes to 7,018 lines / 289,375 bytes: +115 lines and +2,384 bytes. The refactor consolidates ownership and execution but is not a textual reduction. Named composition adapters and required schema companions contribute to this cost; this measurement does not isolate each rule's contribution.
- `duplicate-shape` reported the local dynamic storage-row interface `Storage` as duplicating the inspection metadata interface `Storage`. Renaming the row schema/interface to `StoredRowSchema`/`StoredRow`, without changing either schema shape, removed the diagnostic. This is an observation requiring a minimal reproducer, not a confirmed analyzer defect.
- Generic `Struct.get`/`Tuple.get` references inside `flow` needed explicit native type arguments where contextual inference produced `never`. Native overloaded `Object.freeze` needed typed callback context rather than a bare higher-order reference. These are TypeScript integration costs, not established linter defects.
- Existing compile-negative probes caught repository input types widening to `any[]` when a readonly generic rest tuple crossed native `Effect.fn`, whose argument constraint is mutable. Using the type-only tuple view `[...Args]` restores inferred input contracts and passes all lint rules; no runtime argument copy or compatibility wrapper is introduced.

## Separate tooling issue: not attributed to better-typescript

The harness TypeScript language server returned stale references (including deleted `commands.ts`) and applied stale rename edits to `rpc-cli.ts`, inserting `_tag` into unrelated expressions and past EOF. Those failures were reported through the harness issue tool and the server was reloaded. Do not include them as better-typescript defects without evidence connecting the implementations.
