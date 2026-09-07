import {
  Array,
  Effect,
  Equivalence,
  Function,
  HashSet,
  Match,
  Option,
  Predicate,
  Record,
  Result,
  Schema,
  SchemaAST,
  Stream,
  Struct,
  flow,
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

const StringArraySchema = Schema.Array(Schema.String)
const NumberArraySchema = Schema.Array(Schema.Number)

const StringNativeFlagSchema = Schema.TaggedStruct("string", {})
const NumberNativeFlagSchema = Schema.TaggedStruct("number", { integer: Schema.Boolean })
const BooleanNativeFlagSchema = Schema.TaggedStruct("boolean", {})

const StringEnumNativeFlagSchema = Schema.TaggedStruct("stringEnum", {
  values: StringArraySchema,
})

const NumberEnumNativeFlagSchema = Schema.TaggedStruct("numberEnum", {
  values: NumberArraySchema,
})

const NativeFlagSchema = Schema.Union([
  StringNativeFlagSchema,
  NumberNativeFlagSchema,
  BooleanNativeFlagSchema,
  StringEnumNativeFlagSchema,
  NumberEnumNativeFlagSchema,
])

type NativeFlag = Schema.Schema.Type<typeof NativeFlagSchema>

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

const toOption = (filterGroup: SchemaAST.FilterGroup<unknown>) => Option.some(filterGroup.checks)

const checkIncludesRepresentation = (identifier: string) => (check: SchemaAST.Check<unknown>): boolean => {
  const representationId = Option.fromNullishOr(check.annotations?.representation?.id)

  const hasRepresentation = Option.containsWith(Equivalence.strictEqual<string>())(
    representationId,
    identifier,
  )

  const nestedChecks = flow(toOption, representationOccursIn(identifier))

  return hasRepresentation || pipe(
    Match.value(check),
    Match.when({ _tag: "FilterGroup" }, nestedChecks),
    Match.orElse(Function.constFalse),
  )
}

const representationOccursIn = (identifier: string) => (checks: Option.Option<SchemaAST.Checks>) =>
  Option.exists(checks, Array.some(checkIncludesRepresentation(identifier)))

const stringNativeFlag = () => StringNativeFlagSchema.make({ _tag: "string" })
const numberNativeFlag = (integer: boolean) => NumberNativeFlagSchema.make({ _tag: "number", integer })
const booleanNativeFlag = () => BooleanNativeFlagSchema.make({ _tag: "boolean" })

const stringEnumNativeFlag = (values: ReadonlyArray<string>) =>
  StringEnumNativeFlagSchema.make({ _tag: "stringEnum", values })

const numberEnumNativeFlag = (values: ReadonlyArray<number>) =>
  NumberEnumNativeFlagSchema.make({ _tag: "numberEnum", values })

const stringLiteralNativeFlag = (value: string) =>
  pipe(stringEnumNativeFlag([value]), Option.some)

const numberLiteralNativeFlag = (value: number) =>
  pipe(numberEnumNativeFlag([value]), Option.some)

const nativeBooleanFlag = booleanNativeFlag()
const booleanNativeFlagOption = Option.some(nativeBooleanFlag)
const booleanLiteralNativeFlag = Function.constant(booleanNativeFlagOption)

const stringEnumNativeFlagFor = (
  flags: ReadonlyArray<Schema.Schema.Type<typeof StringEnumNativeFlagSchema>>,
) => pipe(
  flags,
  Array.flatMap(Struct.get("values")),
  stringEnumNativeFlag,
  Option.some,
)

const numberEnumNativeFlagFor = (
  flags: ReadonlyArray<Schema.Schema.Type<typeof NumberEnumNativeFlagSchema>>,
) => pipe(
  flags,
  Array.flatMap(Struct.get("values")),
  numberEnumNativeFlag,
  Option.some,
)

const combineNativeFlags = (native: ReadonlyArray<NativeFlag>) => {
  if (Array.every(native, Schema.is(StringEnumNativeFlagSchema))) {
    return stringEnumNativeFlagFor(native)
  }
  if (Array.every(native, Schema.is(NumberEnumNativeFlagSchema))) {
    return numberEnumNativeFlagFor(native)
  }
  return Array.every(native, Schema.is(BooleanNativeFlagSchema))
    ? booleanNativeFlagOption
    : Option.none<NativeFlag>()
}

const nativeFlagFor: (ast: SchemaAST.AST) => Option.Option<NativeFlag> = (ast) =>
  pipe(
    Match.value(ast),
    Match.tags({
      String: () => pipe(stringNativeFlag(), Option.some),
      Number: ({ checks }) => {
        const checkOptions = Option.fromNullishOr(checks)
        const isInteger = representationOccursIn("effect/schema/isInt")(checkOptions)
        const nativeFlag = numberNativeFlag(isInteger)
        return Option.some(nativeFlag)
      },
      Boolean: () => pipe(booleanNativeFlag(), Option.some),
      Enum: ({ enums }) => {
        const values = Array.map(enums, ([, value]) => value)
        const stringValues = Array.filter(values, Predicate.isString)
        if (Equivalence.strictEqual<number>()(stringValues.length, values.length)) {
          const nativeFlag = stringEnumNativeFlag(stringValues)
          return Option.some(nativeFlag)
        }
        const numberValues = Array.filter(values, Predicate.isNumber)
        if (Equivalence.strictEqual<number>()(numberValues.length, values.length)) {
          const nativeFlag = numberEnumNativeFlag(numberValues)
          return Option.some(nativeFlag)
        }
        return Option.none()
      },
      Literal: ({ literal }) => pipe(
        Match.value(literal),
        Match.when(Match.string, stringLiteralNativeFlag),
        Match.when(Match.number, numberLiteralNativeFlag),
        Match.when(Match.boolean, booleanLiteralNativeFlag),
        Match.orElse(Option.none<NativeFlag>),
      ),
      Union: ({ types }) => {
        const flags = Array.map(types, nativeFlagFor)
        const allFlags = Option.all(flags)
        return Option.flatMap(allFlags, combineNativeFlags)
      },
    }),
    Match.orElse(Option.none<NativeFlag>),
  )

const descriptionFor = (property: SchemaAST.PropertySignature) => {
  const contextAnnotations = Option.fromNullishOr(property.type.context?.annotations)
  const annotations = Option.getOrElse(contextAnnotations, () => property.type.annotations)
  const description = Option.fromNullishOr(annotations?.description)
  return Option.filter(description, Predicate.isString)
}

const makeNativeFlag = (
  name: string,
  native: NativeFlag,
  description: Option.Option<string>,
) => {
  const flag: Flag.Flag<string | number | boolean> = pipe(
    Match.value(native),
    Match.tagsExhaustive({
      string: () => Flag.string(name),
      number: ({ integer }) => integer ? Flag.integer(name) : Flag.float(name),
      boolean: () => Flag.boolean(name),
      stringEnum: ({ values }) => Flag.choice(name, values),
      numberEnum: ({ values }) => {
        const valueEntry = (value: number) => [String(value), value] as const
        const valuesWithEntries = Array.map(values, valueEntry)
        return Flag.choiceWithValue(name, valuesWithEntries)
      },
    }),
  )

  const describedFlag = Option.match(description, {
    onNone: Function.constant(flag),
    onSome: (text) => Flag.withDescription(flag, text),
  })

  return Flag.optional(describedFlag)
}

const makeRpcCli = <Rpcs extends Rpc.AnyWithProps, E = never, R = never>(
  options: Readonly<{
    name: string
    group: RpcGroup.RpcGroup<any>
    subcommands: ReadonlyArray<Command.Command<string, {}, {}, E, R>>
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
                Effect.catch(flow(Function.constant(cause), causeMessage, Effect.succeed)),
                Effect.flatMap((userMessage) =>
                  pipe(
                    CliError.UserError.make({ cause, userMessage }),
                    Effect.fail,
                  )),
              )

            const hasNativeFields = SchemaAST.isObjects(encodedPayloadSchema.ast)
              && Equivalence.strictEqual<number>()(encodedPayloadSchema.ast.indexSignatures.length, 0)

            const properties = hasNativeFields
              ? encodedPayloadSchema.ast.propertySignatures
              : []

            const compiledFields = yield* Effect.forEach(
              properties,
              Effect.fn("RpcCli.compileField")(function* (property) {
                if (!Predicate.isString(property.name)) {
                  return yield* RpcCliDefinitionError.make({
                    procedure: procedure._tag,
                    reason: "payload field names must be strings",
                  })
                }

                const native = nativeFlagFor(property.type)
                if (Option.isNone(native)) {
                  return Option.none()
                }

                const flagName = toFlagName(property.name)
                if (HashSet.has(ReservedFlagNames, flagName)) {
                  return yield* RpcCliDefinitionError.make({
                    procedure: procedure._tag,
                    reason: `payload field ${property.name} collides with reserved flag --${flagName}`,
                  })
                }

                const description = descriptionFor(property)
                const flag = makeNativeFlag(flagName, native.value, description)
                return Option.some({
                  field: property.name,
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

            const inputJsonFlag = Flag.string("input-json")
            const describedInputJsonFlag = Flag.withDescription(inputJsonFlag, "Canonical JSON payload")
            const optionalInputJsonFlag = Flag.optional(describedInputJsonFlag)

            const configEntries = Array.append(
              nativeConfigEntries,
              ["inputJson", optionalInputJsonFlag] as const,
            )

            const config: Record<string, Flag.Flag<Option.Option<unknown>>> = Record.fromEntries(configEntries)

            return Command.make(
              procedure._tag,
              config,
              Effect.fn("RpcCli.execute")(
                function* (arguments_) {
                  const stdio = yield* Stdio.Stdio

                  const readArgument = (key: string) =>
                    pipe(Record.get(arguments_, key), Option.flatten)

                  const inputJson = readArgument("inputJson")

                  const hasNativeInput = Array.some(
                    nativeFields,
                    flow(Struct.get("configKey"), readArgument, Option.isSome),
                  )

                  const mixedInput = Option.isSome(inputJson) && hasNativeInput
                  if (mixedInput) {
                    return yield* CliError.UserError.make({
                      cause: arguments_,
                      userMessage: "--input-json cannot be combined with native field flags",
                    })
                  }

                  const nativeInputEntries = Array.filterMap(
                    nativeFields,
                    ({ field, configKey }) => pipe(
                      readArgument(configKey),
                      Option.map((value) => [field, value] as const),
                      Result.fromOption(Function.constVoid),
                    ),
                  )

                  const nativeInput = Record.fromEntries(nativeInputEntries)

                  const input = Option.match(inputJson, {
                    onSome: Function.identity,
                    onNone: Function.constant(nativeInput),
                  })

                  const payload = yield* Option.match(inputJson, {
                    onSome: () => Schema.decodeUnknownEffect(inputJsonSchema)(input),
                    onNone: () => Schema.decodeUnknownEffect(payloadSchema)(input),
                  })

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
              ),
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
    CliError.UserError | E,
    | RpcClient.Protocol
    | Rpc.MiddlewareClient<Rpcs>
    | Rpc.ServicesClient<Rpcs>
    | Rpc.ServicesServer<Rpcs>
    | Stdio.Stdio
    | R
  >

export const RpcCli = {
  make: makeRpcCli,
}
