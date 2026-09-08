import {
  Array,
  Effect,
  HashSet,
  Layer,
  Option,
  Predicate,
  Record,
  Schema,
  SchemaAST,
  Stream,
  Struct,
  pipe,
} from "effect"
import * as Stdio from "effect/Stdio"
import { CliError, Command, Flag } from "effect/unstable/cli"
import { Rpc, RpcClient, RpcGroup, RpcSchema } from "effect/unstable/rpc"

class RpcCliDefinitionError extends Schema.TaggedError<RpcCliDefinitionError>()(
  "RpcCliDefinitionError",
  { procedure: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `RpcCli cannot compile ${this.procedure}: ${this.reason}`
  }
}

type NativeFlag =
  | { readonly _tag: "string" }
  | { readonly _tag: "number"; readonly integer: boolean }
  | { readonly _tag: "boolean" }
  | { readonly _tag: "stringEnum"; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "numberEnum"; readonly values: ReadonlyArray<number> }

const ReservedFlagNames = HashSet.fromIterable([
  "input-json",
  "help",
  "version",
  "wizard",
  "completions",
  "log-level",
])

const toFlagName = (field: string) =>
  field.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2").replaceAll("_", "-").toLowerCase()

const causeMessage = (cause: unknown) =>
  cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause)

const representationOccursIn = (
  identifier: string,
  checks: SchemaAST.Checks | null | undefined,
): boolean => {
  if (checks === null || checks === undefined) return false
  for (const check of checks) {
    if (check.annotations?.representation?.id === identifier) return true
    if (check._tag === "FilterGroup" && representationOccursIn(identifier, check.checks)) return true
  }
  return false
}

const nativeFlagForEnum = (enums: ReadonlyArray<readonly [string, unknown]>): NativeFlag | undefined => {
  let stringValues: Array<string> | undefined
  let numberValues: Array<number> | undefined

  for (const [, value] of enums) {
    if (typeof value === "string") {
      if (numberValues !== undefined) return undefined
      if (stringValues === undefined) stringValues = []
      stringValues.push(value)
      continue
    }
    if (typeof value === "number") {
      if (stringValues !== undefined) return undefined
      if (numberValues === undefined) numberValues = []
      numberValues.push(value)
      continue
    }
    return undefined
  }

  return numberValues === undefined
    ? { _tag: "stringEnum", values: stringValues ?? [] }
    : { _tag: "numberEnum", values: numberValues }
}

const combineNativeFlags = (flags: ReadonlyArray<NativeFlag>): NativeFlag | undefined => {
  const first = flags[0]
  if (first === undefined) return { _tag: "stringEnum", values: [] }

  if (first._tag === "stringEnum") {
    const values = [...first.values]
    for (let index = 1; index < flags.length; index++) {
      const flag = flags[index]!
      if (flag._tag !== "stringEnum") return undefined
      values.push(...flag.values)
    }
    return { _tag: "stringEnum", values }
  }

  if (first._tag === "numberEnum") {
    const values = [...first.values]
    for (let index = 1; index < flags.length; index++) {
      const flag = flags[index]!
      if (flag._tag !== "numberEnum") return undefined
      values.push(...flag.values)
    }
    return { _tag: "numberEnum", values }
  }

  for (let index = 1; index < flags.length; index++) {
    if (flags[index]!._tag !== "boolean") return undefined
  }
  return first._tag === "boolean" ? first : undefined
}

const nativeFlagFor = (ast: SchemaAST.AST): NativeFlag | undefined => {
  switch (ast._tag) {
    case "String":
      return { _tag: "string" }
    case "Number":
      return {
        _tag: "number",
        integer: representationOccursIn("effect/schema/isInt", ast.checks),
      }
    case "Boolean":
      return { _tag: "boolean" }
    case "Enum":
      return nativeFlagForEnum(ast.enums)
    case "Literal":
      return typeof ast.literal === "string"
        ? { _tag: "stringEnum", values: [ast.literal] }
        : typeof ast.literal === "number"
        ? { _tag: "numberEnum", values: [ast.literal] }
        : typeof ast.literal === "boolean"
        ? { _tag: "boolean" }
        : undefined
    case "Union": {
      const flags: Array<NativeFlag> = []
      for (const type of ast.types) {
        const flag = nativeFlagFor(type)
        if (flag === undefined) return undefined
        flags.push(flag)
      }
      return combineNativeFlags(flags)
    }
    default:
      return undefined
  }
}

const payloadFields = (
  ast: SchemaAST.AST,
  prefix: ReadonlyArray<string> = [],
): ReadonlyArray<Readonly<{ property: SchemaAST.PropertySignature; path: ReadonlyArray<string> }>> => {
  if (!SchemaAST.isObjects(ast) || ast.indexSignatures.length !== 0) return []
  return ast.propertySignatures.flatMap((property) => {
    const path = typeof property.name === "string" ? [...prefix, property.name] : prefix
    return SchemaAST.isObjects(property.type)
      ? payloadFields(property.type, path)
      : [{ property, path }]
  })
}

const setPayloadField = (
  payload: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: unknown,
) => {
  let target = payload
  for (const [index, field] of path.entries()) {
    if (index === path.length - 1) {
      target[field] = value
    } else {
      target = (target[field] ??= Object.create(null)) as Record<string, unknown>
    }
  }
}

const descriptionFor = (property: SchemaAST.PropertySignature): string | undefined => {
  const annotations = property.type.context?.annotations ?? property.type.annotations
  const description = annotations?.description
  return Predicate.isString(description) ? description : undefined
}

const makeNativeFlag = (
  name: string,
  native: NativeFlag,
  description: string | undefined,
) => {
  let flag: Flag.Flag<string | number | boolean>
  switch (native._tag) {
    case "string":
      flag = Flag.string(name)
      break
    case "number":
      flag = native.integer ? Flag.integer(name) : Flag.float(name)
      break
    case "boolean":
      flag = Flag.boolean(name)
      break
    case "stringEnum":
      flag = Flag.choice(name, native.values)
      break
    case "numberEnum":
      flag = Flag.choiceWithValue(name, native.values.map((value) => [String(value), value] as const))
      break
  }
  return Flag.optional(description === undefined ? flag : Flag.withDescription(flag, description))
}

const makeRpcCli = <
  Rpcs extends Rpc.AnyWithProps,
  Subcommands extends ReadonlyArray<Command.Command<any, any, any, any, any>>,
  ProtocolError = never,
  ProtocolRequirements = never,
>(
  options: Readonly<{
    name: string
    group: RpcGroup.RpcGroup<Rpcs>
    protocol: Layer.Layer<RpcClient.Protocol, ProtocolError, ProtocolRequirements>
    subcommands: Subcommands
  }>,
) =>
  pipe(
      Effect.gen(function* () {
        const procedures = options.group.requests.values()

        const subcommands = yield* Effect.forEach(
          procedures,
          Effect.fn("RpcCli.compileProcedure")(function* (procedure: Rpcs) {
            if (RpcSchema.isStreamSchema(procedure.successSchema)) {
              return yield* RpcCliDefinitionError.make({
                procedure: procedure._tag,
                reason: "only unary RPC procedures are supported",
              })
            }

            const payloadSchema = Schema.toCodecJson(procedure.payloadSchema)
            const encodedPayloadSchema = Schema.toEncoded(payloadSchema)
            const inputJsonSchema = Schema.fromJsonString(payloadSchema)
            const outputJsonSchema = Schema.toCodecJson(procedure.successSchema)
            const outputSchema = Schema.fromJsonString(outputJsonSchema)
            const middleware = Array.fromIterable(procedure.middlewares)
            const middlewareErrors = Array.map(middleware, Struct.get("error"))

            const errorsSchema = Schema.Union([
              procedure.errorSchema,
              ...middlewareErrors,
            ])

            const errorJsonSchema = Schema.toCodecJson(errorsSchema)
            const errorSchema = Schema.fromJsonString(errorJsonSchema)

            const reportFailure = (cause: unknown) =>
              pipe(
                Schema.encodeUnknownEffect(errorSchema)(cause),
                Effect.catch(() => Effect.succeed(causeMessage(cause))),
                Effect.flatMap((userMessage) =>
                  Effect.fail(CliError.UserError.make({ cause, userMessage }))),
              )

            const properties = payloadFields(encodedPayloadSchema.ast)
            const decodedProperties = new Map(
              payloadFields(Schema.toType(payloadSchema).ast).map(({ property, path }) => [
                JSON.stringify(path),
                property.type,
              ]),
            )

            const compiledFields = yield* Effect.forEach(
              properties,
              Effect.fn("RpcCli.compileField")(function* ({ property, path }) {
                if (!Predicate.isString(property.name)) {
                  return yield* RpcCliDefinitionError.make({
                    procedure: procedure._tag,
                    reason: "payload field names must be strings",
                  })
                }

                const decoded = decodedProperties.get(JSON.stringify(path))
                // JSON number codecs also encode non-finite values as strings.
                // Native numeric flags cover finite values; JSON retains the full codec.
                const native = nativeFlagFor(property.type) ??
                  (decoded !== undefined && SchemaAST.isNumber(decoded)
                    ? nativeFlagFor(decoded)
                    : undefined)
                if (native === undefined) return Option.none()

                const flagName = path.map(toFlagName).join("-")
                if (HashSet.has(ReservedFlagNames, flagName)) {
                  return yield* RpcCliDefinitionError.make({
                    procedure: procedure._tag,
                    reason: `payload field ${property.name} collides with reserved flag --${flagName}`,
                  })
                }

                return Option.some({
                  path,
                  configKey: flagName,
                  flag: makeNativeFlag(flagName, native, descriptionFor(property)),
                })
              }),
            )

            const nativeFields = Array.getSomes(compiledFields)
            const groupedFlags = Array.groupBy(nativeFields, Struct.get("configKey"))
            const flagEntries = Record.toEntries(groupedFlags)
            yield* Effect.forEach(
              flagEntries,
              Effect.fn("RpcCli.validateFlagNames")(function* ([name, fields]) {
                if (fields.length > 1) {
                  return yield* RpcCliDefinitionError.make({
                    procedure: procedure._tag,
                    reason: `payload fields collide with native flag --${name}`,
                  })
                }
              }),
            )

            const nativeConfigEntries = Array.map(
              nativeFields,
              ({ configKey, flag }) => [configKey, flag] as const,
            )

            const inputJsonFlag = Flag.optional(
              Flag.withDescription(Flag.string("input-json"), "Canonical JSON payload"),
            )

            const configEntries = Array.append(
              nativeConfigEntries,
              ["inputJson", inputJsonFlag] as const,
            )

            const config: Record<string, Flag.Flag<Option.Option<unknown>>> = Record.fromEntries(configEntries)

            const execute = Effect.fn("RpcCli.execute")(
              function* (arguments_: Record<string, Option.Option<unknown>>) {
                const stdio = yield* Stdio.Stdio

                const readArgument = (key: string) =>
                  pipe(Record.get(arguments_, key), Option.flatten)

                const inputJson = readArgument("inputJson")

                const hasNativeInput = nativeFields.some(({ configKey }) =>
                  Option.isSome(readArgument(configKey)))

                if (Option.isSome(inputJson) && hasNativeInput) {
                  return yield* CliError.UserError.make({
                    cause: arguments_,
                    userMessage: "--input-json cannot be combined with native field flags",
                  })
                }

                const nativeInput: Record<string, unknown> = Object.create(null)
                for (const { path, configKey } of nativeFields) {
                  const argument = readArgument(configKey)
                  if (Option.isSome(argument)) {
                    setPayloadField(nativeInput, path, argument.value)
                  }
                }

                const input = Option.isSome(inputJson) ? inputJson.value : nativeInput
                const payload = yield* (Option.isSome(inputJson)
                  ? Schema.decodeUnknownEffect(inputJsonSchema)(input)
                  : Schema.decodeUnknownEffect(payloadSchema)(input))

                const client = yield* RpcClient.make(options.group, {
                  flatten: true,
                })

                // The cast is confined here because validation and the tag come from the same closed RPC group.
                const success = yield* (
                  client as (
                    tag: string,
                    payload: unknown,
                  ) => Effect.Effect<unknown, unknown, unknown>
                )(procedure._tag, payload)

                const encoded =
                  yield* Schema.encodeUnknownEffect(outputSchema)(success)

                const output = Stream.make(`${encoded}\n`)
                const stdout = stdio.stdout()
                yield* Stream.run(output, stdout)
              },
              Effect.scoped,
              Effect.catch(reportFailure),
            )

            return Command.make(
              procedure._tag,
              config,
              (arguments_) => pipe(execute(arguments_), Effect.provide(options.protocol)),
            )
          }),
        )

        yield* Effect.forEach(
          options.subcommands,
          Effect.fn("RpcCli.validateSubcommand")(function* (command) {
            if (options.group.requests.has(command.name)) {
              return yield* RpcCliDefinitionError.make({
                procedure: command.name,
                reason: "RPC command collides with an application subcommand",
              })
            }
          }),
        )
        const commands = Array.appendAll(subcommands, options.subcommands)
        const root = Command.make(options.name)
        return Array.isArrayNonEmpty(commands)
          ? Command.withSubcommands(root, commands)
          : root
      }),

      // Rpcs retains codec and middleware requirements because runtime Schema.Top erases their types.
      Effect.runSync,
  ) as Command.Command<
    string,
    {},
    {},
    CliError.UserError | Command.Error<Subcommands[number]> | ProtocolError,
    | Rpc.MiddlewareClient<Rpcs>
    | Rpc.ServicesClient<Rpcs>
    | Rpc.ServicesServer<Rpcs>
    | Stdio.Stdio
    | Command.Services<Subcommands[number]>
    | ProtocolRequirements
  >

export const RpcCli = {
  make: makeRpcCli,
}
