import {
  Array,
  Data,
  Effect,
  Equivalence,
  Function,
  HashMap,
  HashSet,
  Layer,
  Match,
  Option,
  Predicate,
  Record,
  Schema,
  SchemaAST,
  Stream,
  Struct,
  Tuple,
  pipe,
} from "effect"

import * as Stdio from "effect/Stdio"
import { CliError, Command, Flag } from "effect/unstable/cli"
import { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc"
import { compileUnaryRpc, type UnaryRpcProcedure } from "./rpc-contract.ts"

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
const nativeStringOption = Option.some(nativeStringFlag)
const nativeBooleanOption = Option.some(nativeBooleanFlag)

const ReservedFlagNames = HashSet.fromIterable([
  "input-json",
  "help",
  "version",
  "wizard",
  "completions",
  "log-level",
])

const PayloadPropertySchema = Schema.instanceOf(SchemaAST.PropertySignature)
const PayloadPathSchema = Schema.Array(Schema.String)

class PayloadField extends Schema.Class<PayloadField>("PayloadField")({
  property: PayloadPropertySchema,
  path: PayloadPathSchema,
}) {}

const stringEquals = Equivalence.strictEqual<string>()
const noNativeFlag = Option.none<NativeFlag>()

const toFlagName = (field: string) =>
  field.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2").replaceAll("_", "-").toLowerCase()

const causeMessage = (cause: unknown) =>
  cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause)

const representationOccursIn = (identifier: string, checks: Option.Option<SchemaAST.Checks>) => {
  const representationOccursInCheck = (check: SchemaAST.Check<unknown>) => {
    const representation = Option.fromNullishOr(check.annotations?.representation?.id)
    const directMatch = Option.exists(representation, (value) => stringEquals(value, identifier))

    const nestedMatch = pipe(
      Match.value(check),
      Match.when({ _tag: "FilterGroup" }, ({ checks }) => Array.some(checks, representationOccursInCheck)),
      Match.orElse(Function.constant(false)),
    )

    return directMatch || nestedMatch
  }

  return Option.exists(checks, (values) => Array.some(values, representationOccursInCheck))
}

const nativeFlagForEnum = (ast: SchemaAST.Enum): Option.Option<NativeFlag> => {
  const values = Array.map(ast.enums, ([, value]) => value)
  const stringValues = Array.filter(values, Predicate.isString)
  const numberValues = Array.filter(values, Predicate.isNumber)
  const stringFlag = NativeFlag.StringEnum({ values: stringValues })
  const numberFlag = NativeFlag.NumberEnum({ values: numberValues })
  const hasOnlyStrings = Array.every(values, Predicate.isString)
  if (hasOnlyStrings) return Option.some(stringFlag)

  const hasOnlyNumbers = Array.every(values, Predicate.isNumber)
  return hasOnlyNumbers ? Option.some(numberFlag) : noNativeFlag
}

const stringLiteralFlag = (literal: string) => pipe(NativeFlag.StringEnum({ values: [literal] }), Option.some)
const numberLiteralFlag = (literal: number) => pipe(NativeFlag.NumberEnum({ values: [literal] }), Option.some)

const nativeFlagForLiteral = (ast: SchemaAST.Literal) =>
  pipe(
    Match.value(ast.literal),
    Match.when(Predicate.isString, stringLiteralFlag),
    Match.when(Predicate.isNumber, numberLiteralFlag),
    Match.when(Predicate.isBoolean, Function.constant(nativeBooleanOption)),
    Match.orElse(Function.constant(noNativeFlag)),
  )

const combineNativeFlags = (flags: ReadonlyArray<NativeFlag>): Option.Option<NativeFlag> => {
  const stringEnums = Array.filter(flags, NativeFlag.$is("StringEnum"))
  const numberEnums = Array.filter(flags, NativeFlag.$is("NumberEnum"))
  const stringValues = Array.flatMap(stringEnums, Struct.get("values"))
  const numberValues = Array.flatMap(numberEnums, Struct.get("values"))
  const stringFlag = NativeFlag.StringEnum({ values: stringValues })
  const numberFlag = NativeFlag.NumberEnum({ values: numberValues })
  const emptyFlag = NativeFlag.StringEnum({ values: [] })
  const nonempty = Array.isReadonlyArrayNonEmpty(flags)
  const allBooleans = Array.every(flags, NativeFlag.$is("Boolean"))
  const allStringEnums = Array.every(flags, NativeFlag.$is("StringEnum"))
  const allNumberEnums = Array.every(flags, NativeFlag.$is("NumberEnum"))

  return pipe(
    Match.value({ nonempty, allBooleans, allStringEnums, allNumberEnums }),
    Match.when({ nonempty: false }, () => Option.some(emptyFlag)),
    Match.when({ allBooleans: true }, Function.constant(nativeBooleanOption)),
    Match.when({ allStringEnums: true }, () => Option.some(stringFlag)),
    Match.when({ allNumberEnums: true }, () => Option.some(numberFlag)),
    Match.orElse(Function.constant(noNativeFlag)),
  )
}

const nativeFlagFor: (ast: SchemaAST.AST) => Option.Option<NativeFlag> = (ast) =>
  pipe(
    Match.value(ast),
    Match.when(SchemaAST.isString, Function.constant(nativeStringOption)),
    Match.when(SchemaAST.isNumber, (number) => {
      const checks = Option.fromNullishOr(number.checks)
      const integer = representationOccursIn("effect/schema/isInt", checks)
      const flag = NativeFlag.Number({ integer })
      return Option.some(flag)
    }),
    Match.when(SchemaAST.isBoolean, Function.constant(nativeBooleanOption)),
    Match.when(SchemaAST.isEnum, nativeFlagForEnum),
    Match.when(SchemaAST.isLiteral, nativeFlagForLiteral),
    Match.when(SchemaAST.isUnion, (union) => {
      const flags = Array.map(union.types, nativeFlagFor)
      const availableFlags = Option.all(flags)
      return pipe(availableFlags, Option.flatMap(combineNativeFlags))
    }),
    Match.orElse(Function.constant(noNativeFlag)),
  )

const payloadFields = (
  ast: SchemaAST.AST,
  prefix: ReadonlyArray<string> = [],
): ReadonlyArray<PayloadField> => {
  const objectPayloadFields = (object: SchemaAST.Objects): ReadonlyArray<PayloadField> => {
    if (Array.isReadonlyArrayNonEmpty(object.indexSignatures)) return []

    const toPayloadFields = (property: SchemaAST.PropertySignature): ReadonlyArray<PayloadField> => {
      const path = Predicate.isString(property.name)
        ? Array.append(prefix, property.name)
        : prefix

      return SchemaAST.isObjects(property.type)
        ? payloadFields(property.type, path)
        : [PayloadField.make({ property, path })]
    }

    return Array.flatMap(object.propertySignatures, toPayloadFields)
  }

  return pipe(
    Match.value(ast),
    Match.when(SchemaAST.isObjects, objectPayloadFields),
    Match.orElse(Function.constant([])),
  )
}

const PayloadRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const isPayloadRecords = Schema.is(PayloadRecordSchema)
const emptyPayloads = (): Record<string, unknown> => Object.create(null)

const setPayloadField: (
  payload: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: unknown,
) => Record<string, unknown> = (payload, path, value) =>
  pipe(
    Array.head(path),
    Option.match({
      onNone: Function.constant(payload),
      onSome: (field) => {
        const remainingPath = Array.drop(path, 1)
        const current = Record.get(payload, field)

        const nestedPayload = pipe(
          current,
          Option.filter(isPayloadRecords),
          Option.getOrElse(emptyPayloads),
        )

        const nextValue = Array.isReadonlyArrayNonEmpty(remainingPath)
          ? setPayloadField(nestedPayload, remainingPath, value)
          : value

        return Record.set(payload, field, nextValue)
      },
    }),
  )

const descriptionFor = (property: SchemaAST.PropertySignature) => {
  const annotations = property.type.context?.annotations ?? property.type.annotations
  const description = annotations?.description
  return Predicate.isString(description) ? Option.some(description) : Option.none()
}

const makeNativeFlag = (name: string, native: NativeFlag, description: Option.Option<string>) => {
  const toNumberChoice = (number: number) => [String(number), number] as const

  const numberChoices = (numbers: ReadonlyArray<number>) =>
    Array.map(numbers, toNumberChoice)

  const flag: Flag.Flag<string | number | boolean> = NativeFlag.$match(native, {
    String: () => Flag.string(name),
    Number: (value) => value.integer ? Flag.integer(name) : Flag.float(name),
    Boolean: () => Flag.boolean(name),
    StringEnum: (value) => Flag.choice(name, value.values),
    NumberEnum: (value) => {
      const choices = numberChoices(value.values)
      return Flag.choiceWithValue(name, choices)
    },
  })

  const describedFlag = Option.match(description, {
    onNone: Function.constant(flag),
    onSome: (value) => Flag.withDescription(flag, value),
  })

  return Flag.optional(describedFlag)
}

const nativeFlagForPayloadField = (encoded: SchemaAST.AST, decoded: Option.Option<SchemaAST.AST>) => {
  const encodedFlag = nativeFlagFor(encoded)

  const decodedFlag = pipe(
    decoded,
    Option.filter(SchemaAST.isNumber),
    Option.map((number) => {
      const checks = Option.fromNullishOr(number.checks)
      const integer = representationOccursIn("effect/schema/isInt", checks)
      return NativeFlag.Number({ integer })
    }),
  )

  const useDecodedFlag = Function.constant(decodedFlag)
  return Option.orElse(encodedFlag, useDecodedFlag)
}

const makeInputJsonFlag = () => {
  const flag = Flag.string("input-json")
  const describedFlag = Flag.withDescription(flag, "Canonical JSON payload")
  return Flag.optional(describedFlag)
}

const makeRpcCli = <
  Group extends RpcGroup.Any & Pick<RpcGroup.RpcGroup<Rpc.Any & UnaryRpcProcedure>, "requests">,
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
    const procedures = (options.group as Group & RpcGroup.RpcGroup<Rpc.AnyWithProps>).requests.values()

    const subcommands = yield* Effect.forEach(procedures, Effect.fn("RpcCli.compileProcedure")(function* (procedure) {
      const compiled = compileUnaryRpc(procedure)

      const contract = yield* Effect.fromOption(
        compiled,
        () => RpcCliDefinitionError.make({ procedure: procedure._tag, reason: "only unary RPC procedures are supported" }),
      )

      const inputJsonSchema = Schema.fromJsonString(contract.payload)
      const outputSchema = Schema.fromJsonString(contract.success)
      const errorSchema = Schema.fromJsonString(contract.error)
      const encodedPayloadSchema = Schema.toEncoded(contract.payload)
      const encodedFields = payloadFields(encodedPayloadSchema.ast)
      const decodedPayloadSchema = Schema.toType(contract.payload)
      const decodedPayloadFields = payloadFields(decodedPayloadSchema.ast)

      const toDecodedFieldEntry = (field: PayloadField) =>
        [JSON.stringify(field.path), field.property.type] as const

      const decodedFieldEntries = Array.map(decodedPayloadFields, toDecodedFieldEntry)
      const decodedFields = HashMap.fromIterable(decodedFieldEntries)

      const compileField = Effect.fn("RpcCli.compileField")(function* ({ property, path }: PayloadField) {
        if (!Predicate.isString(property.name)) {
          return yield* RpcCliDefinitionError.make({ procedure: contract.tag, reason: "payload field names must be strings" })
        }

        const serializedPath = JSON.stringify(path)
        const decoded = HashMap.get(decodedFields, serializedPath)
        const native = nativeFlagForPayloadField(property.type, decoded)
        if (Option.isNone(native)) return Option.none()

        const flagNames = Array.map(path, toFlagName)
        const configKey = Array.join(flagNames, "-")

        if (HashSet.has(ReservedFlagNames, configKey)) {
          return yield* RpcCliDefinitionError.make({ procedure: contract.tag, reason: `payload field ${property.name} collides with reserved flag --${configKey}` })
        }

        const description = descriptionFor(property)
        const flag = makeNativeFlag(configKey, native.value, description)
        return Option.some([path, configKey, flag] as const)
      })

      const nativeFieldOptions = yield* Effect.forEach(encodedFields, compileField)
      const nativeFields = Array.getSomes(nativeFieldOptions)
      const configKey = Tuple.get<typeof nativeFields[number], 1>(1)
      const fieldsByConfigKey = Array.groupBy(nativeFields, configKey)
      const groupedFields = Record.values(fieldsByConfigKey)
      const hasCollision = Function.compose(Array.drop(1), Array.isReadonlyArrayNonEmpty)
      const collidingFields = Array.findFirst(groupedFields, hasCollision)

      yield* Option.match(collidingFields, {
        onNone: Function.constant(Effect.void),
        onSome: (fields) => pipe(
          Array.head(fields),
          Option.match({
            onNone: Function.constant(Effect.void),
            onSome: (field) => {
              const key = Tuple.get(field, 1)

              return RpcCliDefinitionError.make({
                procedure: contract.tag,
                reason: `payload fields collide with native flag --${key}`,
              })
            },
          }),
        ),
      })

      const inputJsonEntry = ["inputJson", makeInputJsonFlag()] as const

      const toNativeConfigEntry = (field: typeof nativeFields[number]) =>
        [Tuple.get(field, 1), Tuple.get(field, 2)] as const

      const nativeEntries = Array.map(nativeFields, toNativeConfigEntry)

      const config: Record<string, Flag.Flag<Option.Option<unknown>>> = Record.fromEntries([
        inputJsonEntry,
        ...nativeEntries,
      ])

      const execute = Effect.fn("RpcCli.execute")(function* (arguments_: Record<string, Option.Option<unknown>>) {
        const readArgument = (key: string) => pipe(Record.get(arguments_, key), Option.flatten)
        const inputJson = readArgument("inputJson")

        const toNativeEntry = (field: typeof nativeFields[number]) => {
          const configKey = Tuple.get(field, 1)
          const path = Tuple.get(field, 0)
          return pipe(readArgument(configKey), Option.map((value) => [path, value] as const))
        }

        const nativeEntries = Array.map(nativeFields, toNativeEntry)
        const nativeInputEntries = Array.getSomes(nativeEntries)
        const hasNativeInput = Array.isReadonlyArrayNonEmpty(nativeInputEntries)
        const initialPayload = emptyPayloads()

        const nativeInput = Array.reduce(
          nativeInputEntries,
          initialPayload,
          (payload, [path, value]) => setPayloadField(payload, path, value),
        )

        const hasInputJson = Option.isSome(inputJson)
        const conflictingInputs = hasInputJson && hasNativeInput

        if (conflictingInputs) {
          return yield* CliError.UserError.make({
            cause: arguments_,
            userMessage: "--input-json cannot be combined with native field flags",
          })
        }

        const decodeInputJson = Schema.decodeUnknownEffect(inputJsonSchema)
        const decodeNative = Schema.decodeUnknownEffect(contract.payload)

        const decodeNativeInput = Effect.fn("RpcCli.decodeNativeInput")(function* () {
          const noNativeInput = !hasNativeInput
          const voidPayload = SchemaAST.isVoid(decodedPayloadSchema.ast)
          const emptyVoid = noNativeInput && voidPayload

          const encoded = emptyVoid
            ? yield* Schema.encodeUnknownEffect(contract.payload)(undefined)
            : nativeInput

          return yield* decodeNative(encoded)
        })

        const payload = yield* Option.match(inputJson, {
          onNone: decodeNativeInput,
          onSome: decodeInputJson,
        })

        const client = yield* RpcClient.make(
          options.group as Group & RpcGroup.RpcGroup<Rpc.AnyWithProps>,
          { flatten: true },
        )

        const success = yield* (client as (tag: string, payload: unknown) => Effect.Effect<unknown, unknown, unknown>)(contract.tag, payload)
        const encoded = yield* Schema.encodeUnknownEffect(outputSchema)(success)
        const stdio = yield* Stdio.Stdio
        const output = Stream.make(`${encoded}\n`)
        const stdout = stdio.stdout()
        yield* Stream.run(output, stdout)
      }, Effect.scoped, Effect.catch(Effect.fn("RpcCli.reportFailure")(function* (cause: unknown) {
        const encodeError = Schema.encodeUnknownEffect(errorSchema)
        const encodedError = encodeError(cause)
        const recoverCauseMessage = () => pipe(causeMessage(cause), Effect.succeed)
        const userMessage = yield* Effect.catch(encodedError, recoverCauseMessage)
        return yield* CliError.UserError.make({ cause, userMessage })
      })))

      const provideProtocol = (arguments_: Record<string, Option.Option<unknown>>) =>
        pipe(execute(arguments_), Effect.provide(options.protocol))

      return Command.make(contract.tag, config, provideProtocol)
    }))

    const verifyNoSubcommandCollision = Effect.fn("RpcCli.verifyNoSubcommandCollision")(function* (command: Subcommands[number]) {
      const collision = (options.group as Group & RpcGroup.RpcGroup<Rpc.AnyWithProps>).requests.has(command.name)

      if (collision) {
        return yield* RpcCliDefinitionError.make({
          procedure: command.name,
          reason: "RPC command collides with an application subcommand",
        })
      }
    })

    yield* Effect.forEach(options.subcommands, verifyNoSubcommandCollision)

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
