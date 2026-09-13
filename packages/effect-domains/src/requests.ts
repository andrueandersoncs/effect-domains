import { Array, Equivalence, Option, Record, Schema } from "effect"

export const RequestTokenSchema = Schema.Struct({
  epoch: Schema.Int,
  id: Schema.Int,
  key: Schema.String,
})

export interface RequestToken extends Schema.Schema.Type<typeof RequestTokenSchema> {}

export const RequestStateSchema = Schema.Struct({
  epoch: Schema.Int,
  sequence: Schema.Int,
  pending: Schema.Record(Schema.String, Schema.Int),
  errors: Schema.Record(Schema.String, Schema.String),
})

export interface RequestState extends Schema.Schema.Type<typeof RequestStateSchema> {}

const StartedSchema = Schema.Struct({
  state: RequestStateSchema,
  request: RequestTokenSchema,
})

const sameNumber = Equivalence.strictEqual<number>()

const empty = () => RequestStateSchema.make({ epoch: 0, sequence: 0, pending: {}, errors: {} })

const reset = (state: RequestState) => RequestStateSchema.make({
  epoch: state.epoch + 1,
  sequence: state.sequence,
  pending: {},
  errors: {},
})

const invalidate = (state: RequestState, key: string) => RequestStateSchema.make({
  ...state,
  pending: Record.remove(state.pending, key),
  errors: Record.remove(state.errors, key),
})

const start = (state: RequestState, key: string) => {
  const id = state.sequence + 1
  const request = RequestTokenSchema.make({ epoch: state.epoch, id, key })

  const next = RequestStateSchema.make({
    ...state,
    sequence: id,
    pending: Record.set(state.pending, key, id),
    errors: Record.remove(state.errors, key),
  })

  return StartedSchema.make({ state: next, request })
}

const accepts = (state: RequestState, request: RequestToken) => {
  const sameEpoch = sameNumber(state.epoch, request.epoch)
  const pendingId = Record.get(state.pending, request.key)
  const samePendingRequest = Option.exists(pendingId, (id) => sameNumber(id, request.id))

  return sameEpoch && samePendingRequest
}

const succeed = (state: RequestState, request: RequestToken) =>
  accepts(state, request) ? invalidate(state, request.key) : state

const fail = (state: RequestState, request: RequestToken, error: string) =>
  accepts(state, request)
    ? RequestStateSchema.make({
      ...state,
      pending: Record.remove(state.pending, request.key),
      errors: Record.set(state.errors, request.key, error),
    })
    : state

const pending = (state: RequestState, ...keys: [] | [string]) => {
  const key = Array.head(keys)

  return Option.match(key, {
    onNone: () => !Record.isEmptyRecord(state.pending),
    onSome: (key) => Record.has(state.pending, key),
  })
}

export const Requests = { empty, reset, invalidate, start, accepts, succeed, fail, pending }
