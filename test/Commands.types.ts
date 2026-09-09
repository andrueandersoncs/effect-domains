import { Context, Effect, Layer, Schema, type Types } from "effect"
import { RpcGroup } from "effect/unstable/rpc"
import { Commands } from "effect-domains/commands"

class DeclaredFailure extends Schema.TaggedError<DeclaredFailure>()("DeclaredFailure", {}) {}
class InvocationFailure extends Schema.TaggedError<InvocationFailure>()("InvocationFailure", {}) {}
class UnexpectedFailure extends Schema.TaggedError<UnexpectedFailure>()("UnexpectedFailure", {}) {}

class MappingService extends Context.Service<MappingService, { readonly value: string }>()(
  "test/Commands/MappingService",
) {}

const declaredFailure = DeclaredFailure.make({})
const invocationFailure = InvocationFailure.make({})
const unexpectedFailure = UnexpectedFailure.make({})
const failDeclared = () => Effect.fail(declaredFailure)
const failInvocation = () => Effect.fail(invocationFailure)
const succeedInvalidResult = () => Effect.succeed(1)
const failUnexpected = () => Effect.fail(unexpectedFailure)

const mapInvocationFailure = Effect.fn("Commands.mapInvocationFailure")(function* () {
  const mapping = yield* MappingService
  return `${mapping.value}: mapped`
})

const probeRpc = Commands.rpc("probe", {
  payload: Schema.Void,
  success: Schema.String,
  error: DeclaredFailure,
})

const probeGroup = RpcGroup.make(probeRpc)

const Probe = Commands.make({
  name: "test/Commands/TypeProbe",
  group: probeGroup,
})

const declared = Probe.layer({
  probe: failDeclared,
})

const mappedCatchTags = {
  InvocationFailure: mapInvocationFailure,
}

const mapped = Probe.layer({
  probe: failInvocation,
}, mappedCatchTags)

const preservesMapperRequirement = true satisfies Types.Equals<Layer.Services<typeof mapped>, MappingService>

void declared
void preservesMapperRequirement

Probe.layer({
  // @ts-expect-error because undeclared invocation failures need a catchTags mapper.
  probe: failInvocation,
})

const emptyInvocationFailureMapping: Partial<{
  readonly InvocationFailure: () => Effect.Effect<string>
}> = {}

Probe.layer({
  // @ts-expect-error because an optional mapper absent at runtime cannot discharge an invocation failure.
  probe: failInvocation,
}, emptyInvocationFailureMapping)

const invalidSuccessCatchTags = {
  InvocationFailure: succeedInvalidResult,
}

Probe.layer({
  // @ts-expect-error because mapper successes must satisfy the affected RPC success schema.
  probe: failInvocation,
}, invalidSuccessCatchTags)

const unexpectedFailureCatchTags = {
  InvocationFailure: failUnexpected,
}

Probe.layer({
  // @ts-expect-error because mapper failures must be declared by the affected RPC.
  probe: failInvocation,
}, unexpectedFailureCatchTags)
