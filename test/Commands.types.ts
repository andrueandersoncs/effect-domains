import { Context, Effect, Layer, Schema } from "effect"
import { RpcGroup } from "effect/unstable/rpc"
import { Commands } from "effect-domains/commands"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false

class DeclaredFailure extends Schema.TaggedError<DeclaredFailure>()("DeclaredFailure", {}) {}
class InvocationFailure extends Schema.TaggedError<InvocationFailure>()("InvocationFailure", {}) {}
class UnexpectedFailure extends Schema.TaggedError<UnexpectedFailure>()("UnexpectedFailure", {}) {}
class MappingService extends Context.Service<MappingService, { readonly value: string }>()(
  "test/Commands/MappingService",
) {}

const probeRpc = Commands.rpc("probe", {
  payload: Schema.Void,
  success: Schema.String,
  error: DeclaredFailure,
})

const Probe = Commands.make({
  name: "test/Commands/TypeProbe",
  group: RpcGroup.make(probeRpc),
})

const declared = Probe.layer({
  probe: () => Effect.fail(DeclaredFailure.make({})),
})

const mapped = Probe.layer({
  probe: () => Effect.fail(InvocationFailure.make({})),
}, {
  catchTags: {
    InvocationFailure: () =>
      Effect.gen(function* () {
        const mapping = yield* MappingService
        return `${mapping.value}: mapped`
      }),
  },
})

const preservesMapperRequirement = true satisfies Equal<Layer.Services<typeof mapped>, MappingService>

void declared
void preservesMapperRequirement

Probe.layer({
  // @ts-expect-error because undeclared invocation failures need a catchTags mapper.
  probe: () => Effect.fail(InvocationFailure.make({})),
})

const emptyInvocationFailureMapping: Partial<{
  readonly InvocationFailure: () => Effect.Effect<string>
}> = {}

Probe.layer({
  // @ts-expect-error because an optional mapper absent at runtime cannot discharge an invocation failure.
  probe: () => Effect.fail(InvocationFailure.make({})),
}, {
  catchTags: emptyInvocationFailureMapping,
})
Probe.layer({
  // @ts-expect-error because mapper successes must satisfy the affected RPC success schema.
  probe: () => Effect.fail(InvocationFailure.make({})),
}, {
  catchTags: { InvocationFailure: () => Effect.succeed(1) },
})
Probe.layer({
  // @ts-expect-error because mapper failures must be declared by the affected RPC.
  probe: () => Effect.fail(InvocationFailure.make({})),
}, {
  catchTags: { InvocationFailure: () => Effect.fail(UnexpectedFailure.make({})) },
})
