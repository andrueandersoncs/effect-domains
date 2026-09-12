import { Effect, Schema } from "effect"
import { Operation } from "effect-domains/operation"
import { RepositoryError } from "effect-domains/repository-store"

class DeclaredFailure extends Schema.TaggedError<DeclaredFailure>()("DeclaredFailure", {}) {}
class ForgottenFailure extends Schema.TaggedError<ForgottenFailure>()("ForgottenFailure", {}) {}
class OperationUnavailable extends Schema.TaggedError<OperationUnavailable>()("OperationUnavailable", {}) {}

const declared = () => DeclaredFailure.make({})
const forgotten = () => ForgottenFailure.make({})
const infrastructure = () => RepositoryError.make({ resource: "types", cause: "db" })
const untagged = () => Effect.fail("plain")

Operation.make({ name: "types.declared", success: Schema.Void, errors: DeclaredFailure, unavailable: OperationUnavailable, handler: declared })
Operation.make({ name: "types.infrastructure", success: Schema.Void, errors: DeclaredFailure, unavailable: OperationUnavailable, handler: infrastructure })
Operation.make({ name: "types.untagged", success: Schema.Void, errors: DeclaredFailure, unavailable: OperationUnavailable, handler: untagged })

Operation.make({
  name: "types.forgotten",
  success: Schema.Void,
  errors: DeclaredFailure,
  unavailable: OperationUnavailable,
  // @ts-expect-error because a domain-tagged failure the contract does not declare would be hidden as unavailable.
  handler: forgotten,
})
