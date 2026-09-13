import { Option, Predicate, Schema } from "effect"
import { Page, type Page as PageValue } from "./page.ts"

import {
  Requests,
  RequestStateSchema,
  RequestTokenSchema,
  type RequestState,
  type RequestToken,
} from "./requests.ts"

interface ResourcePagerState<Value> {
  readonly page: PageValue<Value>
  readonly requests: RequestState
}

interface ResourcePagerRequest<Value> extends ResourcePagerState<Value> {
  readonly append: boolean
  readonly cursor: string | null
  readonly request: RequestToken
}

const ResourcePagerStateSchema = Schema.Struct({
  page: Page.schema(Schema.Unknown),
  requests: RequestStateSchema,
})

const ResourcePagerRequestSchema = Schema.Struct({
  ...ResourcePagerStateSchema.fields,
  append: Schema.Boolean,
  cursor: Schema.NullOr(Schema.String),
  request: RequestTokenSchema,
})

const state = <Value>(page: PageValue<Value>, requests: RequestState) =>
  ResourcePagerStateSchema.make({ page, requests }) as ResourcePagerState<Value>

const make = <const Key extends string>(key: Key) => {
  const empty = <Value>(requests: RequestState) => {
    const page = Page.empty<Value>()
    return state(page, requests)
  }

  const begin = <Value>(
    requests: RequestState,
    page: PageValue<Value>,
    append: boolean,
  ) => {
    const exhausted = Predicate.isNull(page.nextCursor)
    const busy = Requests.pending(requests, key)
    const appendExhausted = append && exhausted
    const appendBusy = append && busy
    const blocked = appendExhausted || appendBusy

    if (blocked) return Option.none<ResourcePagerRequest<Value>>()

    const started = Requests.start(requests, key)
    const nextPage = append ? page : Page.empty<Value>()
    const cursor = append ? page.nextCursor : null

    const next = ResourcePagerRequestSchema.make({
      append,
      cursor,
      page: nextPage,
      request: started.request,
      requests: started.state,
    }) as ResourcePagerRequest<Value>

    return Option.some(next)
  }

  const receive = <Value>(
    current: ResourcePagerState<Value>,
    request: RequestToken,
    incoming: PageValue<Value>,
    append: boolean,
  ) => {
    if (!Requests.accepts(current.requests, request)) {
      return Option.none<ResourcePagerState<Value>>()
    }

    const nextPage = Page.receive(current.page, incoming, append)
    const nextRequests = Requests.succeed(current.requests, request)
    const next = state(nextPage, nextRequests)

    return Option.some(next)
  }

  const fail = <Value>(
    current: ResourcePagerState<Value>,
    request: RequestToken,
    error: string,
  ) => {
    if (!Requests.accepts(current.requests, request)) {
      return Option.none<ResourcePagerState<Value>>()
    }

    const nextRequests = Requests.fail(current.requests, request, error)
    const next = state(current.page, nextRequests)
    return Option.some(next)
  }

  const invalidate = <Value>(current: ResourcePagerState<Value>) => {
    const page = Page.empty<Value>()
    const requests = Requests.invalidate(current.requests, key)
    return state(page, requests)
  }

  const reset = <Value>(current: ResourcePagerState<Value>) => {
    const page = Page.empty<Value>()
    const requests = Requests.reset(current.requests)
    return state(page, requests)
  }

  const pending = (requests: RequestState) => Requests.pending(requests, key)

  return { key, empty, begin, receive, fail, invalidate, reset, pending }
}

export const ResourcePager = { make }
