import { Array, Effect, Layer, Schema, Struct, pipe } from "effect"
import { Atom, AtomRpc } from "effect/unstable/reactivity"
import { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc"

export const ReactiveNoteSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
})

const ReactiveNotesSchema = Schema.Array(ReactiveNoteSchema)

const readModelRpc = Rpc.make("field-notes.read-model", {
  success: ReactiveNotesSchema,
})

const saveRpc = Rpc.make("field-notes.save", {
  payload: ReactiveNoteSchema,
  success: ReactiveNoteSchema,
})

export const ReactiveFieldNotesRpcs = RpcGroup.make(readModelRpc, saveRpc)

const noteTitle = Struct.get<typeof ReactiveNoteSchema.Type, "title">("title")
const readTitles = (notes: ReadonlyArray<typeof ReactiveNoteSchema.Type>) => Array.map(notes, noteTitle)

export const makeReactiveFieldNotes = Effect.fn("FieldNotes.Reactive.make")(function* (
  client: RpcClient.RpcClient.Flat<RpcGroup.Rpcs<typeof ReactiveFieldNotesRpcs>>,
) {
  const clientEffect = Effect.succeed(client)

  class Client extends AtomRpc.Service<Client>()("@effect-domains/example-field-notes/ReactiveClient", {
    group: ReactiveFieldNotesRpcs,
    protocol: Layer.empty,
    makeEffect: clientEffect,
  }) {}

  const reads = Client.query("field-notes.read-model", undefined, {
    reactivityKeys: ["field-notes"],
  })

  const titles = pipe(reads, Atom.mapResult(readTitles))
  const save = Client.mutation("field-notes.save")

  return { Client, reads, save, titles } as const
})
