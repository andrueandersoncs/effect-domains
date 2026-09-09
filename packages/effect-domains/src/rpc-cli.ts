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

type NativeFlag = Data.TaggedEnum<{
  String: {}
  Number: { readonly integer: boolean }
  Boolean: {}
  StringEnum: { readonly values: ReadonlyArray<string> }
  NumberEnum: { readonly values: ReadonlyArray<number> }
}>

const NativeFlag = Data.taggedEnum<NativeFlag>()

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

const falseValue = Function.constant(false)

const representationEquals = (identifier: string) => (representation: string) =>
  Equivalence.strictEqual<string>()(representation, identifier)

const representationOccursInCheck = (identifier: string) => (check: SchemaAST.Check<unknown>) => {
  const representationId = Option.fromNullishOr(check.annotations?.representation?.id)

  const hasRepresentation = pipe(
    representationId,
    Option.exists(representationEquals(identifier)),
  )

  const representationInGroup = (group: SchemaAST.FilterGroup<unknown>) => {
    const checks = Option.some(group.checks)
    return representationOccursIn(identifier, checks)
  }

  const nestedRepresentation = pipe(
    Match.value(check),
    Match.when({ _tag: "FilterGroup" }, representationInGroup),
    Match.orElse(falseValue),
  )

  return hasRepresentation || nestedRepresentation
}

const representationOccursIn = (
  identifier: string,
  checks: Option.Option<SchemaAST.Checks>,
): boolean => {
  const predicate = representationOccursInCheck(identifier)
  return Option.exists(checks, Array.some(predicate))
}

const nativeStringFlag = NativeFlag.String()
const nativeBooleanFlag = NativeFlag.Boolean()
const emptyNativeFlag = Option.none<NativeFlag>()
const noNativeFlag = Function.constant(emptyNativeFlag)


const combineStringEnums = (flags: ReadonlyArray<NativeFlag>) => {
  const allStringEnums = Array.every(flags, NativeFlag.$is("StringEnum"))
  if (!allStringEnums) return Option.none<NativeFlag>()

  const stringEnums = Array.filter(flags, NativeFlag.$is("StringEnum"))
  const values = Array.flatMap(stringEnums, Struct.get("values"))
  const native = NativeFlag.StringEnum({ values })
  return Option.some(native)
}

const combineNumberEnums = (flags: ReadonlyArray<NativeFlag>) => {
  const allNumberEnums = Array.every(flags, NativeFlag.$is("NumberEnum"))
  if (!allNumberEnums) return Option.none<NativeFlag>()

  const numberEnums = Array.filter(flags, NativeFlag.$is("NumberEnum"))
  const values = Array.flatMap(numberEnums, Struct.get("values"))
  const native = NativeFlag.NumberEnum({ values })
  return Option.some(native)
}

const combineBooleans = (
  flags: ReadonlyArray<NativeFlag>,
  flag: Extract<NativeFlag, { readonly _tag: "Boolean" }>,
) => {
  const allBooleans = Array.every(flags, NativeFlag.$is("Boolean"))
  return allBooleans ? Option.some(flag) : Option.none<NativeFlag>()
}

const combineBooleanForNativeFlag = (flags: ReadonlyArray<NativeFlag>) => (
  flag: Extract<NativeFlag, { readonly _tag: "Boolean" }>,
) => combineBooleans(flags, flag)

const combineStringEnumForNativeFlag = (flags: ReadonlyArray<NativeFlag>) => (
  _: Extract<NativeFlag, { readonly _tag: "StringEnum" }>,
) => combineStringEnums(flags)

const combineNumberEnumForNativeFlag = (flags: ReadonlyArray<NativeFlag>) => (
  _: Extract<NativeFlag, { readonly _tag: "NumberEnum" }>,
) => combineNumberEnums(flags)

const combineNativeFlagForNativeFlag = (flags: ReadonlyArray<NativeFlag>) => (
  flag: NativeFlag,
) =>
  NativeFlag.$match(flag, {
    String: noNativeFlag,
    Number: noNativeFlag,
    Boolean: combineBooleanForNativeFlag(flags),
    StringEnum: combineStringEnumForNativeFlag(flags),
    NumberEnum: combineNumberEnumForNativeFlag(flags),
  })

const emptyStringEnum = NativeFlag.StringEnum({ values: [] })

const combineNativeFlags = (flags: ReadonlyArray<NativeFlag>): Option.Option<NativeFlag> => {
  const first = Array.head(flags)
  const empty = Option.some(emptyStringEnum)
  return Option.match(first, {
    onNone: Function.constant(empty),
    onSome: combineNativeFlagForNativeFlag(flags),
  })
}

const enumValue = ([, value]: readonly [string, unknown]) => value

const nativeFlagForEnum = (ast: SchemaAST.Enum): Option.Option<NativeFlag> => {
  const values = Array.map(ast.enums, enumValue)
  const strings = Array.filter(values, Predicate.isString)
  const numbers = Array.filter(values, Predicate.isNumber)
  const stringCountMatches = Equivalence.strictEqual<number>()(strings.length, values.length)
  const numberCountMatches = Equivalence.strictEqual<number>()(numbers.length, values.length)

  if (stringCountMatches) {
    const native = NativeFlag.StringEnum({ values: strings })
    return Option.some(native)
  }
  if (numberCountMatches) {
    const native = NativeFlag.NumberEnum({ values: numbers })
    return Option.some(native)
  }
  return Option.none()
}

const numberNativeFlagForAst = (ast: SchemaAST.Number) => {
  const checks = Option.fromNullishOr(ast.checks)
  const integer = representationOccursIn("effect/schema/isInt", checks)
  return NativeFlag.Number({ integer })
}

const numberNativeFlagOption = (ast: SchemaAST.Number) =>
  pipe(ast, numberNativeFlagForAst, Option.some)

const nativeStringEnumOption = (value: string) =>
  pipe(NativeFlag.StringEnum({ values: [value] }), Option.some)

const nativeNumberEnumOption = (value: number) =>
  pipe(NativeFlag.NumberEnum({ values: [value] }), Option.some)

const nativeLiteralFlag = (ast: SchemaAST.Literal) =>
  pipe(
    Match.value(ast.literal),
    Match.when(Predicate.isString, nativeStringEnumOption),
    Match.when(Predicate.isNumber, nativeNumberEnumOption),
    Match.when(Predicate.isBoolean, Function.constant(nativeBooleanOption)),
    Match.orElse(noNativeFlag),
  )

const nativeUnionFlag = (ast: SchemaAST.Union): Option.Option<NativeFlag> => {
  const flags = Array.map(ast.types, nativeFlagFor)
  const combined = Option.all(flags)
  return Option.flatMap(combined, combineNativeFlags)
}

const nativeStringOption = Option.some(nativeStringFlag)
const nativeBooleanOption = Option.some(nativeBooleanFlag)
const nativeStringFlagOption = Function.constant(nativeStringOption)
const nativeBooleanFlagOption = Function.constant(nativeBooleanOption)

const nativeFlagFor = (ast: SchemaAST.AST) =>
  pipe(
    Match.value(ast),
    Match.when(SchemaAST.isString, nativeStringFlagOption),
    Match.when(SchemaAST.isNumber, numberNativeFlagOption),
    Match.when(SchemaAST.isBoolean, nativeBooleanFlagOption),
    Match.when(SchemaAST.isEnum, nativeFlagForEnum),
    Match.when(SchemaAST.isLiteral, nativeLiteralFlag),
    Match.when(SchemaAST.isUnion, nativeUnionFlag),
    Match.orElse(noNativeFlag),
  )

class PayloadField extends Data.Class<{
  readonly property: SchemaAST.PropertySignature
  readonly path: ReadonlyArray<string>
}> {}

class NativeInput extends Data.Class<{
  readonly path: ReadonlyArray<string>
  readonly value: unknown
}> {}

const noPayloadFields = Function.constant<ReadonlyArray<PayloadField>>([])
const emptyPayloadPath = Function.constant<ReadonlyArray<string>>([])

const payloadFieldsForProperty = (prefix: ReadonlyArray<string>) => (
  property: SchemaAST.PropertySignature,
): ReadonlyArray<PayloadField> => {
  const path = Predicate.isString(property.name)
    ? Array.append(prefix, property.name)
    : prefix

  const nested = SchemaAST.isObjects(property.type)
  return nested
    ? payloadFields(property.type, path)
    : [new PayloadField({ property, path })]
}

const objectPayloadFields = (prefix: ReadonlyArray<string>) => (ast: SchemaAST.Objects) => {
  const hasIndexSignatures = !Equivalence.strictEqual<number>()(ast.indexSignatures.length, 0)
  return hasIndexSignatures
    ? noPayloadFields()
    : Array.flatMap(ast.propertySignatures, payloadFieldsForProperty(prefix))
}

const payloadFields = (
  ast: SchemaAST.AST,
  prefix = emptyPayloadPath(),
) =>
  SchemaAST.isObjects(ast)
    ? objectPayloadFields(prefix)(ast)
    : noPayloadFields()

const makePayload = () => Record.empty<string, unknown>()

const isPayloads = (value: unknown): value is Readonly<Record<string, unknown>> => {
  const isObject = Predicate.isObject(value)
  if (!isObject) return isObject

  const isArray = Array.isArray(value)
  return !isArray
}

const payloadsFromUnknown = (value: unknown) =>
  isPayloads(value)
    ? value
    : makePayload()

const payloadWithEntry = (
  payload: Readonly<Record<string, unknown>>,
  remainingPath: ReadonlyArray<string>,
  value: unknown,
) => (field: string): Readonly<Record<string, unknown>> => {
  const lastField = Equivalence.strictEqual<number>()(remainingPath.length, 0)
  if (lastField) return Record.set(payload, field, value)

  const existing = Record.get(payload, field)

  const nested = Option.match(existing, {
    onNone: makePayload,
    onSome: payloadsFromUnknown,
  })

  const next = payloadWithFields(nested, remainingPath, value)
  return Record.set(payload, field, next)
}

const payloadWithFields = (
  payload: Readonly<Record<string, unknown>>,
  path: ReadonlyArray<string>,
  value: unknown,
): Readonly<Record<string, unknown>> => {
  const field = Array.head(path)
  const remainingPath = Array.drop(path, 1)
  return Option.match(field, {
    onNone: Function.constant(payload),
    onSome: payloadWithEntry(payload, remainingPath, value),
  })
}

const propertyAnnotations = (property: SchemaAST.PropertySignature) => {
  const contextAnnotations = Option.fromNullishOr(property.type.context?.annotations)
  const annotations = Option.fromNullishOr(property.type.annotations)
  return pipe(contextAnnotations, Option.orElse(Function.constant(annotations)))
}

const nativeFlagDescriptionFromUnknown = (value: unknown) =>
  pipe(Option.fromNullishOr(value), Option.filter(Predicate.isString))

const descriptionFor = (property: SchemaAST.PropertySignature): Option.Option<string> => {
  const annotations = propertyAnnotations(property)
  const descriptions = Option.map(annotations, Struct.get("description"))
  return Option.flatMap(descriptions, nativeFlagDescriptionFromUnknown)
}

const numberChoice = (value: number) => [String(value), value] as const

const numberNativeFlag = (name: string) => (native: Extract<NativeFlag, { readonly _tag: "Number" }>) =>
  native.integer ? Flag.integer(name) : Flag.float(name)

const stringEnumNativeFlag = (name: string) => (
  native: Extract<NativeFlag, { readonly _tag: "StringEnum" }>,
) => Flag.choice(name, native.values)

const numberEnumNativeFlag = (name: string) => (
  native: Extract<NativeFlag, { readonly _tag: "NumberEnum" }>,
) => {
  const choices = Array.map(native.values, numberChoice)
  return Flag.choiceWithValue(name, choices)
}


const describedFlag = (flag: Flag.Flag<string | number | boolean>) => (description: string) =>
  Flag.withDescription(flag, description)

const makeNativeFlag = (
  name: string,
  native: NativeFlag,
  description: Option.Option<string>,
) => {
  const stringFlag = Flag.string(name)
  const booleanFlag = Flag.boolean(name)
  const stringFlagCase = Function.constant(stringFlag)
  const booleanFlagCase = Function.constant(booleanFlag)

  const flag = NativeFlag.$match(native, {
    String: stringFlagCase,
    Number: numberNativeFlag(name),
    Boolean: booleanFlagCase,
    StringEnum: stringEnumNativeFlag(name),
    NumberEnum: numberEnumNativeFlag(name),
  })

  const flagWithDescription = Option.match(description, {
    onNone: Function.constant(flag),
    onSome: describedFlag(flag),
  })

  return Flag.optional(flagWithDescription)
}

const decodedPayloadEntry = ({ property, path }: PayloadField) => [
  JSON.stringify(path),
  property.type,
] as const

const decodedNativeFlag = (decoded: Option.Option<SchemaAST.AST>) =>
  pipe(decoded, Option.filter(SchemaAST.isNumber), Option.map(numberNativeFlagForAst))

const nativeFlagForPayloadField = (
  encoded: SchemaAST.AST,
  decoded: Option.Option<SchemaAST.AST>,
) => {
  const direct = nativeFlagFor(encoded)
  const fallback = decodedNativeFlag(decoded)
  return pipe(direct, Option.orElse(Function.constant(fallback)))
}

const makeInputJsonFlag = () => {
  const input = Flag.string("input-json")
  const described = Flag.withDescription(input, "Canonical JSON payload")
  return Flag.optional(described)
}

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
) =>
  pipe(
    Effect.gen(function* () {
      const procedures = (
        options.group as Group & RpcGroup.RpcGroup<Rpc.AnyWithProps>
      ).requests.values()

      const subcommands = yield* Effect.forEach(
        procedures,
        Effect.fn("RpcCli.compileProcedure")(function* (procedure) {
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

          const reportFailure = Effect.fn("RpcCli.reportFailure")(function* (cause: unknown) {
            const encoded = Schema.encodeUnknownEffect(errorSchema)(cause)
            const message = causeMessage(cause)
            const fallback = Effect.succeed(message)
            const userMessage = yield* Effect.catch(encoded, Function.constant(fallback))
            const error = CliError.UserError.make({ cause, userMessage })
            return yield* Effect.fail(error)
          })

          const properties = payloadFields(encodedPayloadSchema.ast)
          const decodedPayloadSchema = Schema.toType(payloadSchema)
          const decodedFields = payloadFields(decodedPayloadSchema.ast)
          const decodedEntries = Array.map(decodedFields, decodedPayloadEntry)
          const decodedProperties = HashMap.fromIterable(decodedEntries)

          const compiledFields = yield* Effect.forEach(
            properties,
            Effect.fn("RpcCli.compileField")(function* ({ property, path }) {
              if (!Predicate.isString(property.name)) {
                return yield* RpcCliDefinitionError.make({
                  procedure: procedure._tag,
                  reason: "payload field names must be strings",
                })
              }

              const decodedPath = JSON.stringify(path)
              const decoded = HashMap.get(decodedProperties, decodedPath)
              const native = nativeFlagForPayloadField(property.type, decoded)
              if (Option.isNone(native)) return Option.none()

              const flagNameParts = Array.map(path, toFlagName)
              const flagName = Array.join(flagNameParts, "-")
              if (HashSet.has(ReservedFlagNames, flagName)) {
                return yield* RpcCliDefinitionError.make({
                  procedure: procedure._tag,
                  reason: `payload field ${property.name} collides with reserved flag --${flagName}`,
                })
              }

              const description = descriptionFor(property)
              const flag = makeNativeFlag(flagName, native.value, description)
              return Option.some({
                path,
                configKey: flagName,
                flag,
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

          const inputJsonFlag = makeInputJsonFlag()

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

              const hasArgumentForNativeField = ({ configKey }: typeof nativeFields[number]) =>
                pipe(readArgument(configKey), Option.isSome)

              const hasNativeInput = Array.some(nativeFields, hasArgumentForNativeField)
              const inputJsonAndNativeInput = Option.isSome(inputJson) && hasNativeInput
              if (inputJsonAndNativeInput) {
                return yield* CliError.UserError.make({
                  cause: arguments_,
                  userMessage: "--input-json cannot be combined with native field flags",
                })
              }

              const nativeInputValue = (path: ReadonlyArray<string>) => (value: unknown) =>
                new NativeInput({ path, value })

              const nativeInputForField = ({ path, configKey }: typeof nativeFields[number]) =>
                pipe(readArgument(configKey), Option.map(nativeInputValue(path)))

              const nativeOptions = Array.map(nativeFields, nativeInputForField)
              const nativeInputs = Array.getSomes(nativeOptions)

              const setNativeInput = (
                payload: Readonly<Record<string, unknown>>,
                { path, value }: NativeInput,
              ) => payloadWithFields(payload, path, value)

              const initialNativeInput = makePayload()
              const nativeInput = Array.reduce(nativeInputs, initialNativeInput, setNativeInput)

              const input = Option.match(inputJson, {
                onNone: Function.constant(nativeInput),
                onSome: Function.identity,
              })

              const nativePayload = Schema.decodeUnknownEffect(payloadSchema)(input)
              const jsonPayload = Schema.decodeUnknownEffect(inputJsonSchema)(input)

              const payload = yield* Option.match(inputJson, {
                onNone: Function.constant(nativePayload),
                onSome: Function.constant(jsonPayload),
              })

              const client = yield* RpcClient.make(
                options.group as Group & RpcGroup.RpcGroup<Rpc.AnyWithProps>,
                { flatten: true },
              )

              const success = yield* (
                client as (
                  tag: string,
                  payload: unknown,
                ) => Effect.Effect<unknown, unknown, unknown>
              )(procedure._tag, payload)

              const encoded = yield* Schema.encodeUnknownEffect(outputSchema)(success)
              const output = Stream.make(`${encoded}\n`)
              const stdout = stdio.stdout()
              yield* Stream.run(output, stdout)
            },
            Effect.scoped,
            Effect.catch(reportFailure),
          )

          const provideProtocol = (arguments_: Record<string, Option.Option<unknown>>) =>
            pipe(execute(arguments_), Effect.provide(options.protocol))

          return Command.make(procedure._tag, config, provideProtocol)
        }),
      )

      yield* Effect.forEach(
        options.subcommands,
        Effect.fn("RpcCli.validateSubcommand")(function* (command) {
          if ((
            options.group as Group & RpcGroup.RpcGroup<Rpc.AnyWithProps>
          ).requests.has(command.name)) {
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

export const RpcCli = {
  make: makeRpcCli,
}
