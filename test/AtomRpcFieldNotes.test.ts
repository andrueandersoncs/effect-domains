import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Equivalence, Function, Match, Ref, Schema, pipe } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"
import { RpcClient, RpcGroup } from "effect/unstable/rpc"

import {
  makeReactiveFieldNotes,
  ReactiveFieldNotesRpcs,
  ReactiveNoteSchema,
} from "../examples/field-notes/reactive.ts"

const noNotes = (notes: ReadonlyArray<unknown>) => Equivalence.strictEqual<number>()(notes.length, 0)
const oneNote = (notes: ReadonlyArray<unknown>) => Equivalence.strictEqual<number>()(notes.length, 1)
const savedNote = (note: typeof ReactiveNoteSchema.Type) => Equivalence.strictEqual<string>()(note.id, "note-1")
const unknownRpc = (tag: string) => Effect.die(`Unknown Field Notes RPC: ${tag}`)

const awaitSuccess = Effect.fn("AtomRpcFieldNotes.awaitSuccess")(function*<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  predicate: (value: A) => boolean,
) {
  const completed = yield* Deferred.make<A>()

  const receive: Parameters<typeof registry.subscribe<AsyncResult.AsyncResult<A, E>>>[1] = (result) => {
    const success = AsyncResult.isSuccess(result)
    if (!success) return

    const matches = predicate(result.value)
    if (!matches) return

    const completion = Deferred.succeed(completed, result.value)
    Effect.runFork(completion)
  }

  const unsubscribe = registry.subscribe(atom, receive, { immediate: true })
  const value = yield* Deferred.await(completed)

  yield* Effect.sync(unsubscribe)

  return value
})

it.effect("an AtomRpc mutation invalidates and refetches a mounted read model", Effect.fn("AtomRpcFieldNotes.refetch")(function* () {
  const state = yield* Ref.make<ReadonlyArray<typeof ReactiveNoteSchema.Type>>([])
  const reads = yield* Ref.make(0)
  const incrementReads = Ref.update(reads, (count) => count + 1)
  const currentState = Ref.get(state)
  const read = Effect.andThen(incrementReads, currentState)

  const persist = Effect.fn("AtomRpcFieldNotes.persist")(function* (note: typeof ReactiveNoteSchema.Type) {
    yield* Ref.update(state, (notes) => [...notes, note])
    return note
  })

  const client = ((tag: string, payload: unknown) => {
    const decoded = Schema.decodeUnknownEffect(ReactiveNoteSchema)(payload)
    const save = pipe(decoded, Effect.orDie, Effect.flatMap(persist))

    return pipe(
      Match.value(tag),
      Match.when("field-notes.read-model", Function.constant(read)),
      Match.when("field-notes.save", Function.constant(save)),
      Match.orElse(unknownRpc),
    )
  }) as RpcClient.RpcClient.Flat<RpcGroup.Rpcs<typeof ReactiveFieldNotesRpcs>>

  const atoms = yield* makeReactiveFieldNotes(client)
  const registry = AtomRegistry.make()
  const initial = yield* awaitSuccess(registry, atoms.reads, noNotes)
  const initialReadCount = yield* Ref.get(reads)

  expect(initial).toEqual([])
  expect(initialReadCount).toBe(1)

  registry.set(atoms.save, {
    payload: { id: "note-1", title: "Reactivity proved" },
    reactivityKeys: ["field-notes"],
  })

  yield* awaitSuccess(registry, atoms.save, savedNote)

  const notes = yield* awaitSuccess(registry, atoms.reads, oneNote)
  const finalReadCount = yield* Ref.get(reads)

  expect(notes).toEqual([{ id: "note-1", title: "Reactivity proved" }])
  expect(finalReadCount).toBe(2)

  registry.dispose()
}))
