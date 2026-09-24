---
globs:
  - "**/*.{ts,tsx,js,jsx,mjs,cjs}"
---
# Repetition requires abstraction

Repeated implementation of the same concern is evidence that its abstraction is missing. Do not leave a decision, invariant, schema shape, transformation, error mapping, or sequence of operations defined independently in multiple places in this file. Even two occurrences are repetition; do not excuse them merely because they are short, readable, or currently identical.

Make the shared concept the single source of truth: extract the common operation, value, schema, policy, or declarative data and interpret it once. Keep genuinely varying inputs and authored business decisions explicit rather than hiding different semantics behind flags or a premature universal helper. Reusing a shared abstraction at multiple call sites is not repeated implementation.

Judge from the supplied file alone. Report a violation only when the file itself demonstrates two or more implementations of the same concern and a coherent abstraction can replace them without losing meaningful distinctions. Do not assume duplicates exist in other files or treat merely similar syntax with different semantics as the same concern.
