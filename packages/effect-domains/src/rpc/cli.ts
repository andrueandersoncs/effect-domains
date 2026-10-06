import { Array, Effect, Layer, Option, Schema, SchemaAST, Stream, pipe } from "effect"

import * as Stdio from "effect/Stdio"
import { CliError, Command, Flag } from "effect/unstable/cli"
import { RpcClient, RpcGroup } from "effect/unstable/rpc"
import type { ApplicationIR } from "../application/index.ts"
import { compileUnaryRpc, type RpcProcedure } from "./contract.ts"

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

const makeRpcCli = <
  Rpcs extends RpcProcedure,
  Subcommands extends ReadonlyArray<Command.Command<any, any, any, any, any>>,
  ProtocolError = never,
  ProtocolRequirements = never,
>(
  options: Readonly<{
    application: ApplicationIR & Readonly<{ group: RpcGroup.RpcGroup<Rpcs> }>
    protocol: Layer.Layer<RpcClient.Protocol, ProtocolError, ProtocolRequirements>
    subcommands: Subcommands
  }>,
) => pipe(
  Effect.gen(function* () {
    const procedures = (
      // SAFETY: Descriptors match because options require this exact group.
      options.application.group as RpcGroup.RpcGroup<Rpcs>
    ).requests.values()

    const subcommands = yield* Effect.forEach(procedures, Effect.fn("RpcCli.compileProcedure")(function* (procedure) {
      const compiled = compileUnaryRpc<Rpcs>(procedure)

      const contract = yield* Effect.fromOption(
        compiled,
        () => RpcCliDefinitionError.make({ procedure: procedure._tag, reason: "only unary RPC procedures are supported" }),
      )

      const inputJsonSchema = Schema.fromJsonString<typeof contract.payloadSchema>(contract.payloadSchema)
      const outputSchema = Schema.fromJsonString<typeof contract.successSchema>(contract.successSchema)
      const errorSchema = Schema.fromJsonString<typeof contract.errorSchema>(contract.errorSchema)
      const payloadTypeSchema = Schema.toType<typeof contract.payloadSchema>(contract.payloadSchema)
      const voidPayload = SchemaAST.isVoid(payloadTypeSchema.ast)
      const decodePayload = Schema.decodeUnknownEffect<typeof contract.payloadSchema>(contract.payloadSchema)
      const encodePayload = Schema.encodeUnknownEffect<typeof contract.payloadSchema>(contract.payloadSchema)
      const decodeJsonInput = Schema.decodeUnknownEffect<typeof inputJsonSchema>(inputJsonSchema)
      const encodeOutput = Schema.encodeUnknownEffect<typeof outputSchema>(outputSchema)
      const encodeError = Schema.encodeUnknownEffect<typeof errorSchema>(errorSchema)
      const contractGroup = RpcGroup.make(contract)

      const decodeNoInput = Effect.fn("RpcCli.decodeNoInput")(function* () {
        const encoded = voidPayload ? yield* encodePayload(undefined) : {}

        return yield* decodePayload(encoded)
      })

      const reportFailure = Effect.fn("RpcCli.reportFailure")(function* (cause: unknown) {
        const userMessage = yield* pipe(
          encodeError(cause),
          Effect.catch(() => pipe(cause, causeMessage, Effect.succeed)),
        )

        return yield* CliError.UserError.make({ cause, userMessage })
      })

      const execute = Effect.fn("RpcCli.execute")(function* (inputJson: Option.Option<string>) {
        const payload = yield* Option.match(inputJson, {
          onNone: decodeNoInput,
          onSome: decodeJsonInput,
        })

        const client = yield* RpcClient.make(contractGroup, { flatten: true })
        const success = yield* client(contract._tag, payload)
        const encoded = yield* encodeOutput(success)
        const stdio = yield* Stdio.Stdio
        const output = Stream.make(`${encoded}\n`)
        const stdout = stdio.stdout()

        yield* Stream.run(output, stdout)
      }, Effect.scoped, Effect.catch(reportFailure))

      const inputFlag = Flag.string("input-json")
      const describedInput = Flag.withDescription(inputFlag, "Canonical JSON payload")
      const inputJson = Flag.optional(describedInput)

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

    const commands = Array.appendAll<typeof subcommands[number], Subcommands[number]>(subcommands, options.subcommands)
    const root = Command.make(options.application.name)

    return Array.isArrayNonEmpty(commands) ? Command.withSubcommands<typeof commands>(commands)(root) : root
  }),
  Effect.runSync,
)

export const RpcCli = { make: makeRpcCli }