import { expect, it } from "@effect/vitest"
import { Option } from "effect"
import { Page } from "effect-domains/page"
import { Requests } from "effect-domains/requests"
import { ResourcePager } from "effect-domains/resource-pager"

const Pager = ResourcePager.make("books.list")

it("owns replacement, continuation, and stale page request state", () => {
  const requests = Requests.empty()
  const emptyPage = Page.empty<string>()
  const replacementOption = Pager.begin(requests, emptyPage, false)
  const replacement = Option.getOrThrow(replacementOption)
  const expectedReplacementPage = Page.empty()
  const replacementPending = Pager.pending(replacement.requests)

  expect(replacement.page).toEqual(expectedReplacementPage)
  expect(replacement.cursor).toBeNull()
  expect(replacementPending).toBe(true)

  const stale = Pager.receive(
    { page: replacement.page, requests: replacement.requests },
    { ...replacement.request, id: replacement.request.id - 1 },
    { items: ["stale"], nextCursor: null },
    false,
  )

  const staleIgnored = Option.isNone(stale)

  expect(staleIgnored).toBe(true)

  const firstOption = Pager.receive(
    { page: replacement.page, requests: replacement.requests },
    replacement.request,
    { items: ["first"], nextCursor: "next" },
    false,
  )

  const first = Option.getOrThrow(firstOption)
  const continuationOption = Pager.begin(first.requests, first.page, true)
  const continuation = Option.getOrThrow(continuationOption)

  expect(continuation.page).toEqual(first.page)
  expect(continuation.cursor).toBe("next")

  const completeOption = Pager.receive(
    { page: continuation.page, requests: continuation.requests },
    continuation.request,
    { items: ["second"], nextCursor: null },
    true,
  )

  const complete = Option.getOrThrow(completeOption)

  expect(complete.page).toEqual({ items: ["first", "second"], nextCursor: null })

  const exhaustedAppend = Pager.begin(complete.requests, complete.page, true)
  const appendSuppressed = Option.isNone(exhaustedAppend)
  expect(appendSuppressed).toBe(true)
})
