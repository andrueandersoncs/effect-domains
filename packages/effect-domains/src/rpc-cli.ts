import { Array, Effect, Layer, Option, Schema, SchemaAST, Stream, pipe } from "effect"

import * as Stdio from "effect/Stdio"
import { CliError, Command, Flag } from "effect/unstable/cli"
import { RpcClient, RpcGroup } from "effect/unstable/rpc"
import type { ApplicationIR } from "./application.ts"
import { compileUnaryRpc, type RpcProcedure } from "./rpc-contract.ts"

class RpcCliDefinitionError extends Schema.TaggedError<RpcCliDefinitionError>()(
  "RpcCliDefinitionError",
  { procedure: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `RpcCli cannot compile ${this.procedure}: ${this.reason}`
  }
}

const causeMessage = (cause: unknown) =>
  cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause)

const makeInputJsonFlag = () => {
  const flag = Flag.string("input-json")
  const describedFlag = Flag.withDescription(flag, "Canonical JSON payload")

  return Flag.optional(describedFlag)
}



const makeRpcCli = <
  App extends ApplicationIR,
  Subcommands extends ReadonlyArray<Command.Command<any, any, any, any, any>>,
  ProtocolError = never,
  ProtocolRequirements = never,
>(
  options: Readonly<{
    application: App
    protocol: Layer.Layer<RpcClient.Protocol, ProtocolError, ProtocolRequirements>
    subcommands: Subcommands
  }>,
) => pipe(
  Effect.gen(function* () {
    const procedures = options.application.group.requests.values()

    const subcommands = yield* Effect.forEach(procedures, Effect.fn("RpcCli.compileProcedure")(function* (procedure) {
      const compiled = compileUnaryRpc(procedure)

      const contract = yield* Effect.fromOption(
        compiled,
        () => RpcCliDefinitionError.make({ procedure: procedure._tag, reason: "only unary RPC procedures are supported" }),
      )

      const inputJsonSchema = Schema.fromJsonString(contract.payloadSchema)
      const outputSchema = Schema.fromJsonString(contract.successSchema)
      const errorSchema = Schema.fromJsonString(contract.errorSchema)
      const decodedPayloadSchema = Schema.toType(contract.payloadSchema)

      const execute = Effect.fn("RpcCli.execute")(function* (inputJson: Option.Option<string>) {
        const decodeNoInput = Effect.fn("RpcCli.decodeNoInput")(function* () {
          const encoded = SchemaAST.isVoid(decodedPayloadSchema.ast)
            ? yield* Schema.encodeUnknownEffect(contract.payloadSchema)(undefined)
            : {}

          return yield* Schema.decodeUnknownEffect(contract.payloadSchema)(encoded)
        })

        const payload = yield* Option.match(inputJson, {
          onNone: decodeNoInput,
          onSome: Schema.decodeUnknownEffect(inputJsonSchema),
        })

        const contractGroup = RpcGroup.make(contract)
        const client = yield* RpcClient.make(contractGroup, { flatten: true })
        const success = yield* client(contract._tag, payload)
        const encoded = yield* Schema.encodeUnknownEffect(outputSchema)(success)
        const stdio = yield* Stdio.Stdio
        const output = Stream.make(`${encoded}\n`)
        const stdout = stdio.stdout()

        yield* Stream.run(output, stdout)
      }, Effect.scoped, Effect.catch(Effect.fn("RpcCli.reportFailure")(function* (cause: unknown) {
        const encodedError = Schema.encodeUnknownEffect(errorSchema)(cause)

        const fallbackMessage = Effect.fn("RpcCli.fallbackMessage")(function* () {
          return causeMessage(cause)
        })

        const userMessage = yield* pipe(encodedError, Effect.catch(fallbackMessage))

        return yield* CliError.UserError.make({ cause, userMessage })
      })))

      const inputJson = makeInputJsonFlag()

      return Command.make(contract._tag, { inputJson }, ({ inputJson }) =>
        pipe(execute(inputJson), Effect.provide(options.protocol)))
    }))

    const verifyNoSubcommandCollision = Effect.fn("RpcCli.verifyNoSubcommandCollision")(function* (command: Subcommands[number]) {
      const collision = options.application.group.requests.has(command.name)

      if (collision) {
        return yield* RpcCliDefinitionError.make({
          procedure: command.name,
          reason: "RPC command collides with an application subcommand",
        })
      }
    })

    yield* Effect.forEach(options.subcommands, verifyNoSubcommandCollision)

    const commands = Array.appendAll(subcommands, options.subcommands)
    const root = Command.make(options.application.name)

    return Array.isArrayNonEmpty(commands) ? Command.withSubcommands(root, commands) : root
  }),
  Effect.runSync,
)

export const RpcCli = { make: makeRpcCli }