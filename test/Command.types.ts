import { Effect, Schema } from "effect"
import { Command } from "effect-domains/command"
import { RepositoryError } from "effect-domains/repository-store"

class DeclaredFailure extends Schema.TaggedError<DeclaredFailure>()("DeclaredFailure", {}) {}
class ForgottenFailure extends Schema.TaggedError<ForgottenFailure>()("ForgottenFailure", {}) {}
class CommandUnavailable extends Schema.TaggedError<CommandUnavailable>()("CommandUnavailable", {}) {}

const declared = () => DeclaredFailure.make({})
const forgotten = () => ForgottenFailure.make({})
const infrastructure = () => RepositoryError.make({ resource: "types", cause: "db" })
const untagged = () => Effect.fail("plain")

const declaredSpec = Command.define({
  name: "types.declared",
  success: Schema.Void,
  errors: DeclaredFailure,
  unavailable: CommandUnavailable,
})
Command.implement(declaredSpec, declared)
Command.implement(declaredSpec, infrastructure)
Command.implement(declaredSpec, untagged)

const forgottenSpec = Command.define({
  name: "types.forgotten",
  success: Schema.Void,
  errors: DeclaredFailure,
  unavailable: CommandUnavailable,
})
// @ts-expect-error because a domain-tagged failure the contract does not declare would be hidden as unavailable.
Command.implement(forgottenSpec, forgotten)
