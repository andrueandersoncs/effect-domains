import {
  Effect,
  Function,
  pipe,
  SynchronizedRef,
} from "effect"

/**

Use when: one database-backed value should be shared across local fibers because
its fallible writes need serialized write-through persistence.

Example: yield `PersistedRef.make(commit)(load)`, then yield its `get`, `set`,
`update`, `modify`, or `refresh` Effects because the resulting value behaves
like a fallible reference.

**/
// Keep a distinct type because Effect Ref mutations cannot carry persistence failures or requirements.
export class PersistedRef<
  A,
  LoadError,
  LoadRequirements,
  CommitError,
  CommitRequirements,
> {
  private constructor(
    private readonly backing: SynchronizedRef.SynchronizedRef<A>,
    private readonly load: Effect.Effect<A, LoadError, LoadRequirements>,
    private readonly commit: (
      previous: A,
      next: A,
    ) => Effect.Effect<A, CommitError, CommitRequirements>,
  ) {}

  private commitValue(value: A) {
    const commit = this.commit

    return Effect.fn("PersistedRef.commitValue")(function* (previous: A) {
      return yield* commit(previous, value)
    })
  }

  private commitUpdate(f: (current: A) => A) {
    const commit = this.commit

    return Effect.fn("PersistedRef.commitUpdate")(function* (previous: A) {
      const next = f(previous)

      return yield* commit(previous, next)
    })
  }

  private commitModification<B>(
    f: (current: A) => readonly [result: B, next: A],
  ) {
    const commit = this.commit

    return Effect.fn("PersistedRef.commitModification")(function* (
      previous: A,
    ) {
      const [result, next] = f(previous)
      const persisted = yield* commit(previous, next)

      return [result, persisted] as const
    })
  }

  /** Returns memory without querying persistence because reads are cache-first. */
  get get(): Effect.Effect<A> {
    return SynchronizedRef.get(this.backing)
  }

  /** Reloads under the mutation lock because refresh must not race a commit. */
  get refresh(): Effect.Effect<A, LoadError, LoadRequirements> {
    const reload = Function.constant(this.load)

    return SynchronizedRef.updateAndGetEffect(this.backing, reload)
  }

  /** Publishes only after commit because persistence remains authoritative. */
  set(value: A): Effect.Effect<A, CommitError, CommitRequirements> {
    const commitValue = this.commitValue(value)

    return pipe(
      SynchronizedRef.updateAndGetEffect(this.backing, commitValue),
      Effect.uninterruptible,
    )
  }

  /** Returns the committed value because persistence may canonicalize the proposal. */
  update(
    f: (current: A) => A,
  ): Effect.Effect<A, CommitError, CommitRequirements> {
    const commitUpdate = this.commitUpdate(f)

    return pipe(
      SynchronizedRef.updateAndGetEffect(this.backing, commitUpdate),
      Effect.uninterruptible,
    )
  }

  /** Returns a separate result because callers can model atomic Ref modifications. */
  modify<B>(
    f: (current: A) => readonly [result: B, next: A],
  ): Effect.Effect<B, CommitError, CommitRequirements> {
    const commitModification = this.commitModification(f)

    return pipe(
      SynchronizedRef.modifyEffect(this.backing, commitModification),
      Effect.uninterruptible,
    )
  }

  /** Loads first because the database value is authoritative at construction. */
  static make<A, CommitError, CommitRequirements>(
    commit: (
      previous: A,
      next: A,
    ) => Effect.Effect<A, CommitError, CommitRequirements>,
  ): <LoadError, LoadRequirements>(
    load: Effect.Effect<A, LoadError, LoadRequirements>,
  ) => Effect.Effect<
    PersistedRef<
      A,
      LoadError,
      LoadRequirements,
      CommitError,
      CommitRequirements
    >,
    LoadError,
    LoadRequirements
  > {
    return Effect.fn("PersistedRef.make")(function* (load) {
      const initial = yield* load
      const backing = yield* SynchronizedRef.make(initial)

      return new PersistedRef(backing, load, commit)
    })
  }
}
