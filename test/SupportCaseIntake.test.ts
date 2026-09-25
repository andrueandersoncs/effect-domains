import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Ref } from "effect"
import { Machine } from "effect-machine"
import {
  IntakeApi,
  IntakeEvent,
  IntakeState,
  intakeMachine,
} from "@effect-domains/example-support-cases/intake-machine"

it.effect("interrupts a customer lookup on back-navigation and rejects stale results", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const interrupted = yield* Deferred.make<void>()
    const actor = yield* Machine.spawn(intakeMachine).pipe(Effect.provideService(IntakeApi, {
      customer: () => Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      ),
      open: () => Effect.succeed({ id: "unused" }),
    }))

    yield* actor.start
    yield* actor.call(IntakeEvent.Lookup({ customerId: "acme" }))
    yield* Deferred.await(started)
    yield* actor.call(IntakeEvent.Back)
    yield* Deferred.await(interrupted)

    expect(yield* actor.snapshot).toMatchObject({ _tag: "Customer", customerId: "acme" })
    const stale = yield* actor.call(IntakeEvent.Found({ customerId: "acme", customerName: "Old result" }))

    expect(stale.transitioned).toBe(false)
    expect(yield* actor.snapshot).toMatchObject({ _tag: "Customer" })
  }).pipe(Machine.scoped, Effect.scoped),
)

it.effect("submits at most once while a case is opening and ignores invalid phase events", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<{ readonly id: string }>()
    const opens = yield* Ref.make(0)
    const actor = yield* Machine.spawn(intakeMachine).pipe(Effect.provideService(IntakeApi, {
      customer: (id) => Effect.succeed({ id, name: "Acme" }),
      open: () => Ref.update(opens, (count) => count + 1).pipe(Effect.andThen(Deferred.await(release))),
    }))

    yield* actor.start
    const earlySubmit = yield* actor.call(IntakeEvent.Submit({ subject: "Issue", priority: "normal" }))

    expect(earlySubmit.transitioned).toBe(false)
    yield* actor.call(IntakeEvent.Lookup({ customerId: "acme" }))
    yield* actor.waitFor(IntakeState.Editing)
    yield* actor.call(IntakeEvent.Submit({ subject: "   ", priority: "normal" }))
    expect(yield* actor.snapshot).toMatchObject({ _tag: "Editing" })
    expect(yield* Ref.get(opens)).toBe(0)
    yield* actor.call(IntakeEvent.Submit({ subject: "Issue", priority: "normal" }))
    const duplicate = yield* actor.call(IntakeEvent.Submit({ subject: "Issue", priority: "normal" }))

    expect(duplicate.transitioned).toBe(false)
    expect(yield* actor.snapshot).toMatchObject({ _tag: "Submitting" })
    yield* Deferred.succeed(release, { id: "case-1" })
    yield* actor.waitFor(IntakeState.Complete)
    expect(yield* Ref.get(opens)).toBe(1)
    expect(yield* actor.snapshot).toMatchObject({ _tag: "Complete", caseId: "case-1" })
  }).pipe(Machine.scoped, Effect.scoped),
)
