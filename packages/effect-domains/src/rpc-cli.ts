import {
  Array,
  Data,
  Effect,
  HashMap,
  HashSet,
  Layer,
  Option,
  Predicate,
  Record,
  Schema,
  SchemaAST,
  Stream,
  pipe,
} from "effect"
import * as Stdio from "effect/Stdio"
import { CliError, Command, Flag } from "effect/unstable/cli"
import { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc"
import { compileUnaryRpc } from "./rpc-contract.ts"

class RpcCliDefinitionError extends Schema.TaggedError<RpcCliDefinitionError>()(
  "RpcCliDefinitionError",
  { procedure: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `RpcCli cannot compile ${this.procedure}: ${this.reason}`
  }
}

type NativeFlag = Data.TaggedEnum<{
  String: {}
  Number: { readonly integer: boolean }
  Boolean: {}
  StringEnum: { readonly values: ReadonlyArray<string> }
  NumberEnum: { readonly values: ReadonlyArray<number> }
}>

const NativeFlag = Data.taggedEnum<NativeFlag>()
const nativeStringFlag = NativeFlag.String()
const nativeBooleanFlag = NativeFlag.Boolean()
const ReservedFlagNames = HashSet.fromIterable([
  "input-json",
  "help",
  "version",
  "wizard",
  "completions",
  "log-level",
])

interface PayloadField {
  readonly property: SchemaAST.PropertySignature
  readonly path: ReadonlyArray<string>
}

const toFlagName = (field: string) =>
  field.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2").replaceAll("_", "-").toLowerCase()

const causeMessage = (cause: unknown) =>
  cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause)

const representationOccursIn = (identifier: string, checks: Option.Option<SchemaAST.Checks>): boolean =>
  Option.exists(checks, (values) => Array.some(values, (check) => {
    const representation = check.annotations?.representation?.id
    if (representation === identifier) return true
    return check._tag === "FilterGroup" && representationOccursIn(identifier, Option.some(check.checks))
  }))

const nativeFlagForEnum = (ast: SchemaAST.Enum): Option.Option<NativeFlag> => {
  const values = Array.map(ast.enums, ([, value]) => value)
  if (Array.every(values, Predicate.isString)) return Option.some(NativeFlag.StringEnum({ values }))
  if (Array.every(values, Predicate.isNumber)) return Option.some(NativeFlag.NumberEnum({ values }))
  return Option.none()
}

const nativeFlagForLiteral = (ast: SchemaAST.Literal): Option.Option<NativeFlag> => {
  if (typeof ast.literal === "string") return Option.some(NativeFlag.StringEnum({ values: [ast.literal] }))
  if (typeof ast.literal === "number") return Option.some(NativeFlag.NumberEnum({ values: [ast.literal] }))
  if (typeof ast.literal === "boolean") return Option.some(nativeBooleanFlag)
  return Option.none()
}

const combineNativeFlags = (flags: ReadonlyArray<NativeFlag>): Option.Option<NativeFlag> => {
  if (flags.length === 0) return Option.some(NativeFlag.StringEnum({ values: [] }))
  if (Array.every(flags, NativeFlag.$is("Boolean"))) return Option.some(nativeBooleanFlag)
  if (Array.every(flags, NativeFlag.$is("StringEnum"))) {
    return Option.some(NativeFlag.StringEnum({ values: Array.flatMap(flags, (flag) => flag.values) }))
  }
  if (Array.every(flags, NativeFlag.$is("NumberEnum"))) {
    return Option.some(NativeFlag.NumberEnum({ values: Array.flatMap(flags, (flag) => flag.values) }))
  }
  return Option.none()
}

const nativeFlagFor = (ast: SchemaAST.AST): Option.Option<NativeFlag> => {
  if (SchemaAST.isString(ast)) return Option.some(nativeStringFlag)
  if (SchemaAST.isNumber(ast)) {
    const checks = Option.fromNullishOr(ast.checks)
    return Option.some(NativeFlag.Number({ integer: representationOccursIn("effect/schema/isInt", checks) }))
  }
  if (SchemaAST.isBoolean(ast)) return Option.some(nativeBooleanFlag)
  if (SchemaAST.isEnum(ast)) return nativeFlagForEnum(ast)
  if (SchemaAST.isLiteral(ast)) return nativeFlagForLiteral(ast)
  if (SchemaAST.isUnion(ast)) return pipe(Array.map(ast.types, nativeFlagFor), Option.all, Option.flatMap(combineNativeFlags))
  return Option.none()
}
const payloadFields = (ast: SchemaAST.AST, prefix: ReadonlyArray<string> = []): ReadonlyArray<PayloadField> => {
  if (!SchemaAST.isObjects(ast) || ast.indexSignatures.length > 0) return []

  const fields: PayloadField[] = []
  for (const property of ast.propertySignatures) {
    const path = typeof property.name === "string" ? [...prefix, property.name] : prefix
    if (SchemaAST.isObjects(property.type)) fields.push(...payloadFields(property.type, path))
    else fields.push({ property, path })
  }
  return fields
}

const isPayload = (value: unknown): value is Record<string, unknown> =>
  Predicate.isObject(value) && !Array.isArray(value)

const setPayloadField = (payload: Record<string, unknown>, path: ReadonlyArray<string>, value: unknown) => {
  const field = path[0]
  if (field === undefined) return

  let target = payload
  for (let index = 0; index < path.length - 1; index++) {
    const current = path[index]!
    const existing = target[current]
    const nested: Record<string, unknown> = isPayload(existing) ? existing : Object.create(null)
    target[current] = nested
    target = nested
  }
  target[path[path.length - 1]!] = value
}

const descriptionFor = (property: SchemaAST.PropertySignature): Option.Option<string> => {
  const annotations = property.type.context?.annotations ?? property.type.annotations
  const description = annotations?.description
  return typeof description === "string" ? Option.some(description) : Option.none()
}

const makeNativeFlag = (name: string, native: NativeFlag, description: Option.Option<string>) => {
  const flag: Flag.Flag<string | number | boolean> = NativeFlag.$match(native, {
    String: () => Flag.string(name),
    Number: (value) => value.integer ? Flag.integer(name) : Flag.float(name),
    Boolean: () => Flag.boolean(name),
    StringEnum: (value) => Flag.choice(name, value.values),
    NumberEnum: (value) => Flag.choiceWithValue(name, Array.map(value.values, (number) => [String(number), number] as const)),
  })
  return Flag.optional(Option.match(description, {
    onNone: () => flag,
    onSome: (value) => Flag.withDescription(flag, value),
  }))
}

const nativeFlagForPayloadField = (encoded: SchemaAST.AST, decoded: Option.Option<SchemaAST.AST>) =>
  pipe(
    nativeFlagFor(encoded),
    Option.orElse(() => pipe(decoded, Option.filter(SchemaAST.isNumber), Option.map((ast) => NativeFlag.Number({
      integer: representationOccursIn("effect/schema/isInt", Option.fromNullishOr(ast.checks)),
    })))),
  )

const makeInputJsonFlag = () => Flag.optional(Flag.withDescription(Flag.string("input-json"), "Canonical JSON payload"))

const makeRpcCli = <
  Group extends RpcGroup.Any & Pick<RpcGroup.RpcGroup<Rpc.AnyWithProps>, "requests">,
  Subcommands extends ReadonlyArray<Command.Command<any, any, any, any, any>>,
  ProtocolError = never,
  ProtocolRequirements = never,
>(
  options: Readonly<{
    name: string
    group: Group
    protocol: Layer.Layer<RpcClient.Protocol, ProtocolError, ProtocolRequirements>
    subcommands: Subcommands
  }>,
) => pipe(
  Effect.gen(function* () {
    const group = options.group as Group & RpcGroup.RpcGroup<Rpc.AnyWithProps>
    const subcommands = yield* Effect.forEach(group.requests.values(), Effect.fn("RpcCli.compileProcedure")(function* (procedure) {
      const contract = yield* Effect.fromOption(
        compileUnaryRpc(procedure),
        () => RpcCliDefinitionError.make({ procedure: procedure._tag, reason: "only unary RPC procedures are supported" }),
      )
      const payloadSchema = contract.payload
      const inputJsonSchema = Schema.fromJsonString(payloadSchema)
      const outputSchema = Schema.fromJsonString(contract.success)
      const errorSchema = Schema.fromJsonString(contract.error)
      const encodedFields = payloadFields(Schema.toEncoded(payloadSchema).ast)
      const decodedFields = HashMap.fromIterable(Array.map(payloadFields(Schema.toType(payloadSchema).ast), (field) => [JSON.stringify(field.path), field.property.type] as const))

      const nativeFields = Array.getSomes(yield* Effect.forEach(encodedFields, Effect.fn("RpcCli.compileField")(function* ({ property, path }) {
        if (typeof property.name !== "string") {
          return yield* RpcCliDefinitionError.make({ procedure: contract.tag, reason: "payload field names must be strings" })
        }
        const native = nativeFlagForPayloadField(property.type, HashMap.get(decodedFields, JSON.stringify(path)))
        if (Option.isNone(native)) return Option.none()
        const configKey = Array.join(Array.map(path, toFlagName), "-")
        if (HashSet.has(ReservedFlagNames, configKey)) {
          return yield* RpcCliDefinitionError.make({ procedure: contract.tag, reason: `payload field ${property.name} collides with reserved flag --${configKey}` })
        }
        return Option.some({ path, configKey, flag: makeNativeFlag(configKey, native.value, descriptionFor(property)) })
      })))

      const config: Record<string, Flag.Flag<Option.Option<unknown>>> = { inputJson: makeInputJsonFlag() }
      const names = new Set<string>()
      for (const field of nativeFields) {
        if (names.has(field.configKey)) {
          return yield* RpcCliDefinitionError.make({ procedure: contract.tag, reason: `payload fields collide with native flag --${field.configKey}` })
        }
        names.add(field.configKey)
        config[field.configKey] = field.flag
      }

      const execute = Effect.fn("RpcCli.execute")(function* (arguments_: Record<string, Option.Option<unknown>>) {
        const readArgument = (key: string) => pipe(Record.get(arguments_, key), Option.flatten)
        const inputJson = readArgument("inputJson")
        const nativeInput: Record<string, unknown> = Object.create(null)
        let hasNativeInput = false

        for (const field of nativeFields) {
          const value = readArgument(field.configKey)
          if (Option.isSome(value)) {
            hasNativeInput = true
            setPayloadField(nativeInput, field.path, value.value)
          }
        }

        if (Option.isSome(inputJson) && hasNativeInput) {
          return yield* CliError.UserError.make({
            cause: arguments_,
            userMessage: "--input-json cannot be combined with native field flags",
          })
        }

        const payload = yield* (Option.isSome(inputJson)
          ? Schema.decodeUnknownEffect(inputJsonSchema)(inputJson.value)
          : Schema.decodeUnknownEffect(payloadSchema)(nativeInput))
        const client = yield* RpcClient.make(group, { flatten: true })
        const success = yield* (client as (tag: string, payload: unknown) => Effect.Effect<unknown, unknown, unknown>)(contract.tag, payload)
        const encoded = yield* Schema.encodeUnknownEffect(outputSchema)(success)
        const stdio = yield* Stdio.Stdio
        yield* Stream.run(Stream.make(`${encoded}\n`), stdio.stdout())
      }, Effect.scoped, Effect.catch(Effect.fn("RpcCli.reportFailure")(function* (cause: unknown) {
        const encoded = Schema.encodeUnknownEffect(errorSchema)(cause)
        const userMessage = yield* Effect.catch(encoded, () => Effect.succeed(causeMessage(cause)))
        return yield* CliError.UserError.make({ cause, userMessage })
      })))

      return Command.make(contract.tag, config, (arguments_) => pipe(execute(arguments_), Effect.provide(options.protocol)))
    }))

    for (const command of options.subcommands) {
      if (group.requests.has(command.name)) {
        return yield* RpcCliDefinitionError.make({ procedure: command.name, reason: "RPC command collides with an application subcommand" })
      }
    }
    const commands = Array.appendAll(subcommands, options.subcommands)
    const root = Command.make(options.name)
    return Array.isArrayNonEmpty(commands) ? Command.withSubcommands(root, commands) : root
  }),
  Effect.runSync,
) as Command.Command<
  string,
  {},
  {},
  CliError.UserError | Command.Error<Subcommands[number]> | ProtocolError,
  | Rpc.MiddlewareClient<RpcGroup.Rpcs<Group>>
  | Rpc.ServicesClient<RpcGroup.Rpcs<Group>>
  | Rpc.ServicesServer<RpcGroup.Rpcs<Group>>
  | Stdio.Stdio
  | Command.Services<Subcommands[number]>
  | ProtocolRequirements
>

export const RpcCli = { make: makeRpcCli }
