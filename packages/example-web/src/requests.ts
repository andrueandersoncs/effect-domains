import { Record, Schema } from "effect"

export const RequestTokenSchema = Schema.Struct({
  epoch: Schema.Int,
  id: Schema.Int,
  key: Schema.String,
})
export type RequestToken = typeof RequestTokenSchema.Type

export const RequestStateSchema = Schema.Struct({
  epoch: Schema.Int,
  sequence: Schema.Int,
  pending: Schema.Record(Schema.String, Schema.Int),
  errors: Schema.Record(Schema.String, Schema.String),
})
export type RequestState = typeof RequestStateSchema.Type

const empty = (): RequestState => ({ epoch: 0, sequence: 0, pending: {}, errors: {} })

const reset = (state: RequestState): RequestState => ({
  epoch: state.epoch + 1,
  sequence: state.sequence,
  pending: {},
  errors: {},
})

const invalidate = (state: RequestState, key: string): RequestState => ({
  ...state,
  pending: Record.remove(state.pending, key),
  errors: Record.remove(state.errors, key),
})

const start = (state: RequestState, key: string) => {
  const id = state.sequence + 1
  const request: RequestToken = { epoch: state.epoch, id, key }
  const next: RequestState = {
    ...state,
    sequence: id,
    pending: Record.set(state.pending, key, id),
    errors: Record.remove(state.errors, key),
  }
  return { state: next, request }
}

const accepts = (state: RequestState, request: RequestToken) =>
  state.epoch === request.epoch && state.pending[request.key] === request.id

const succeed = (state: RequestState, request: RequestToken): RequestState =>
  accepts(state, request) ? invalidate(state, request.key) : state

const fail = (state: RequestState, request: RequestToken, error: string): RequestState =>
  accepts(state, request) ? {
    ...state,
    pending: Record.remove(state.pending, request.key),
    errors: Record.set(state.errors, request.key, error),
  } : state

const pending = (state: RequestState, key?: string): boolean =>
  key === undefined ? !Record.isEmptyRecord(state.pending) : Record.has(state.pending, key)

export const Requests = { empty, reset, invalidate, start, accepts, succeed, fail, pending }
