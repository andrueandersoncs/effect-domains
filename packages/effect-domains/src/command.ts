import { Array, Cause, Data, Effect, Equivalence, Function, Layer, Match, Option, Record, Schema, Struct, flow, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import type { SqlError } from "effect/unstable/sql"
import { AuthorizationSubject, type SubjectPolicy } from "./authorization.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { RepositoryError, RepositoryStore, ResourceNotFound, UniqueViolation, VersionConflict } from "./repository-store.ts"
import { RpcBundle, type RpcProcedure } from "./rpc-contract.ts"
import { Resource, type ResourceSpec, type Resource as CompiledResource } from "./resource.ts"
import type { CompiledReadModel, ReadModelSpec } from "./read-model.ts"
import type { Table } from "./table.ts"

type Codec<SchemaType extends Schema.Constraint | undefined> = SchemaType extends Schema.Constraint
  ? Schema.toCodecJson<SchemaType>
  : Schema.toCodecJson<typeof Schema.Void>

type PayloadType<Payload> = Payload extends Schema.Constraint ? Payload["Type"] : void
type SubjectType<Policy> = Policy extends SubjectPolicy<infer Subject> ? Subject["Type"] : never

/** Handlers receive the typed subject only when a policy protects the operation. */
type Handler<Payload, Success extends Schema.Constraint, Policy, Failure, Requirements> = Policy extends SubjectPolicy
  ? (input: PayloadType<Payload>, subject: SubjectType<Policy>) => Effect.Effect<Success["Type"], Failure, Requirements>
  : (input: PayloadType<Payload>) => Effect.Effect<Success["Type"], Failure, Requirements>

type ProtectedHandler<Payload, Success extends Schema.Constraint, Policy, Failure, Requirements> =
  (input: PayloadType<Payload>, subject: SubjectType<Policy>) => Effect.Effect<Success["Type"], Failure, Requirements>

type UnprotectedHandler<Payload, Success extends Schema.Constraint, Failure, Requirements> =
  (input: PayloadType<Payload>) => Effect.Effect<Success["Type"], Failure, Requirements>

type HandlerResult<Implementation> =
  Implementation extends (...arguments_: infer _Arguments) => infer Result ? Result : never

type HandlerFailure<Implementation> = Effect.Error<HandlerResult<Implementation>>
type HandlerRequirements<Implementation> = Effect.Services<HandlerResult<Implementation>>


type Procedure<Name extends string, Payload extends Schema.Constraint | undefined, Success extends Schema.Constraint, Error extends Schema.Constraint, Policy> = Rpc.Rpc<
  Name,
  Codec<Payload>,
  Codec<Success>,
  Codec<Error>,
  Policy extends SubjectPolicy ? typeof AuthorizationRpc : never
>


/** The empty-field error class that replaces every failure the contract does not declare. */
interface UnavailableConstructor<Error extends Schema.Constraint> {
  readonly make: (fields: Record<string, never>) => Error["Type"]
}

type Tagged = Readonly<Record<"_tag", string>>




type CommandDependency =
  | ResourceSpec
  | CompiledResource
  | ReadModelSpec
  | CompiledReadModel
  | Table

class CommandDependencySet extends Data.Class<{
  readonly tables: ReadonlyArray<Table>
  readonly readModels: ReadonlyArray<ReadModelSpec | CompiledReadModel>
}> {}

const dependencyTable = pipe(
  Match.type<ResourceSpec | Table>(),
  Match.tagsExhaustive({
    ResourceSpec: Resource.table,
    Table: (table) => table,
  }),
)

const dependenciesFrom: (dependency: CommandDependency) => ReadonlyArray<Table> = pipe(
  Match.type<CommandDependency>(),
  Match.tagsExhaustive({
    ResourceSpec: (dependency) => [Resource.table(dependency)],
    CompiledResource: (dependency) => [dependency.table],
    ReadModelSpec: (dependency) => {
      const dependencies = Record.values(dependency.definition.tables)

      return Array.map(dependencies, dependencyTable)
    },
    CompiledReadModel: Struct.get<CompiledReadModel, "dependencies">("dependencies"),
    Table: (dependency) => [dependency],
  }),
)

const readModelTags: ReadonlyArray<CommandDependency["_tag"]> = [
  "ReadModelSpec",
  "CompiledReadModel",
]

const isReadModel = (
  dependency: CommandDependency,
): dependency is ReadModelSpec | CompiledReadModel =>
  Array.contains(readModelTags, dependency._tag)

const dependencySet = (
  dependencies: ReadonlyArray<CommandDependency>,
): CommandDependencySet => {
  const readModels = Array.filter(dependencies, isReadModel)
  const declaredTables = Array.flatMap(dependencies, dependenciesFrom)

  const tables = Array.dedupeWith(
    declaredTables,
    Equivalence.strictEqual<Table>(),
  )

  const frozenTables = Object.freeze([...tables])
  const frozenReadModels = Object.freeze([...readModels])

  return new CommandDependencySet({
    tables: frozenTables,
    readModels: frozenReadModels,
  })
}


type CommandSpecBoundary = Readonly<{
  name: string
  success: Schema.Constraint
  unavailable: Schema.Constraint & UnavailableConstructor<Schema.Constraint>
}> & Readonly<Partial<{
  errors: Schema.Constraint
  payload: Schema.Constraint
  policy: SubjectPolicy
  transaction: boolean
  dependencies: ReadonlyArray<CommandDependency>
}>>

type CommandSpec<
  Name extends string = string,
  Payload extends Schema.Constraint | undefined = Schema.Constraint | undefined,
  Success extends Schema.Constraint = Schema.Constraint,
  Errors extends Schema.Constraint | undefined = Schema.Constraint | undefined,
  Unavailable extends Schema.Constraint = Schema.Constraint,
  Policy extends SubjectPolicy | undefined = SubjectPolicy | undefined,
  Transaction extends boolean | undefined = boolean | undefined,
> = CommandSpecBoundary & Readonly<{
  name: Name
  success: Success
  unavailable: Unavailable & UnavailableConstructor<Unavailable>
}> & (Payload extends Schema.Constraint ? Readonly<{ payload: Payload }> : unknown)
  & (Errors extends Schema.Constraint ? Readonly<{ errors: Errors }> : unknown)
  & (Policy extends SubjectPolicy ? Readonly<{ policy: Policy }> : unknown)
  & (Transaction extends boolean ? Readonly<{ transaction: Transaction }> : unknown)


const defineCommand = <
  const Name extends string,
  const Payload extends Schema.Constraint | undefined = undefined,
  const Success extends Schema.Constraint = typeof Schema.Void,
  const Errors extends Schema.Constraint | undefined = undefined,
  const Unavailable extends Schema.Constraint = typeof Schema.Never,
  const Policy extends SubjectPolicy | undefined = undefined,
  const Transaction extends boolean | undefined = undefined,
>(
  definition: CommandSpecBoundary & CommandSpec<Name, Payload, Success, Errors, Unavailable, Policy, Transaction>,
// SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
) => Object.freeze({ ...definition }) as CommandSpec<
  Name,
  Payload,
  Success,
  Errors,
  Unavailable,
  Policy,
  Transaction
>


/** A command specification paired with its translated Effect implementation. */
export interface CommandLive<Contract extends RpcProcedure = RpcProcedure> {
  readonly spec: CommandSpecBoundary
  readonly rpc: Contract
  readonly handler: (input: never) => Effect.Effect<unknown, unknown, unknown>
}



const inTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  pipe(RepositoryStore, Effect.flatMap((store) => store.transaction(effect)))

// Only a lone declared failure passes through because interruptions and defects are never part of the contract.
const declaredFailure = (isDeclared: (value: unknown) => boolean, cause: Cause.Cause<unknown>) => {
  const single = Equivalence.strictEqual<number>()(cause.reasons.length, 1)

  const declared = (reason: Cause.Reason<unknown>) => Cause.isFailReason(reason) && isDeclared(reason.error)
    ? Option.some(reason.error)
    : Option.none<unknown>()

  const head = Array.head(cause.reasons)

  return single ? Option.flatMap(head, declared) : Option.none<unknown>()
}

// Protected operations pass authorization failures through because the middleware already publishes them.
const isMiddlewareFailure = Schema.is(AuthorizationRpc.errorSchema)
const alwaysUndeclared = Function.constant(false)


const compileCommand = <
  const Spec extends CommandSpecBoundary,
  const Implementation = never,
>(
  definition: Spec,
  implementation: Implementation & NoInfer<
    Handler<
      Spec extends { readonly payload: infer Payload extends Schema.Constraint } ? Payload : void,
      Spec["success"],
      Spec extends { readonly policy: infer Policy extends SubjectPolicy } ? Policy : unknown,
      HandlerFailure<Implementation>,
      HandlerRequirements<Implementation>
    >
      & ([HandlerFailure<Implementation> extends infer Failure
        ? Failure extends Tagged
          ? Failure extends
            | (Spec extends { readonly errors: infer Errors extends Schema.Constraint }
              ? Errors["Type"]
              : never)
            | Spec["unavailable"]["Type"]
            | SqlError.SqlError
            | Schema.SchemaError
            | RepositoryError
            | ResourceNotFound
            | UniqueViolation
            | VersionConflict
            | Cause.NoSuchElementError
            | Schema.Schema.Type<typeof AuthorizationRpc.errorSchema>
            ? never
            : Failure
          : never
        : never] extends [never]
        ? unknown
        : Readonly<{ undeclaredFailure:
          HandlerFailure<Implementation> extends infer Failure
            ? Failure extends Tagged
              ? Failure extends
                | (Spec extends { readonly errors: infer Errors extends Schema.Constraint }
                  ? Errors["Type"]
                  : never)
                | Spec["unavailable"]["Type"]
                | SqlError.SqlError
                | Schema.SchemaError
                | RepositoryError
                | ResourceNotFound
                | UniqueViolation
                | VersionConflict
                | Cause.NoSuchElementError
                | Schema.Schema.Type<typeof AuthorizationRpc.errorSchema>
                ? never
                : Failure
              : never
            : never
        }>)
  >,
) => {
  type Payload = Spec extends { readonly payload: infer Value extends Schema.Constraint } ? Value : undefined
  type Success = Spec["success"]
  type Errors = Spec extends { readonly errors: infer Value extends Schema.Constraint } ? Value : undefined
  type Unavailable = Spec["unavailable"]
  type Policy = Spec extends { readonly policy: infer Value extends SubjectPolicy } ? Value : undefined
  type Transaction = Spec extends { readonly transaction: infer Value extends boolean } ? Value : undefined

  type Failure =
    | (Errors extends Schema.Constraint ? Errors["Type"] : never)
    | Unavailable["Type"]

  type ErrorSchema = Schema.Codec<
    Failure,
    (Errors extends Schema.Constraint ? Errors["Encoded"] : never) | Unavailable["Encoded"],
    (Errors extends Schema.Constraint ? Errors["DecodingServices"] : never) | Unavailable["DecodingServices"],
    (Errors extends Schema.Constraint ? Errors["EncodingServices"] : never) | Unavailable["EncodingServices"]
  >

  const payload = Option.fromNullishOr(definition.payload)
  const payloadSchema = Option.getOrElse(payload, Function.constant(Schema.Void))
  const payloadJsonSchema = Schema.toCodecJson(payloadSchema)
  const successJsonSchema = Schema.toCodecJson(definition.success)
  const declaredErrors = Option.fromNullishOr(definition.errors)

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const errorSchema = Option.match(declaredErrors, {
    onNone: () => definition.unavailable,
    onSome: (errors) => Schema.Union([errors, definition.unavailable]),
  }) as ErrorSchema

  const errorJsonSchema = Schema.toCodecJson(errorSchema)
  const contract = Rpc.make(definition.name, { payload: payloadJsonSchema, success: successJsonSchema, error: errorJsonSchema })
  const policy = Option.fromNullishOr(definition.policy)

  const rpc = Option.match(policy, {
    onNone: Function.constant(contract),
    onSome: (subjectPolicy) => contract.middleware(AuthorizationRpc).annotate(AuthorizationRpc.policy, subjectPolicy),
  })

  const transaction = Option.fromNullishOr(definition.transaction)
  const transactional = Option.getOrElse(transaction, Function.constant(false))

  const invoke = (input: PayloadType<Payload>) => Option.match(policy, {
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    onNone: () => (implementation as UnprotectedHandler<
      Payload,
      Success,
      HandlerFailure<Implementation>,
      HandlerRequirements<Implementation>
    >)(input),
    onSome: () => pipe(
      AuthorizationSubject,
      // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
      Effect.flatMap((subject) => (implementation as ProtectedHandler<
        Payload,
        Success,
        Policy,
        HandlerFailure<Implementation>,
        HandlerRequirements<Implementation>
      // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
      >)(input, subject as SubjectType<Policy>)),
    ),
  })

  const run = transactional ? flow(invoke, inTransaction) : invoke
  const unavailable = () => definition.unavailable.make({})
  const fallback = Effect.failSync(unavailable)
  const isContractFailure = Schema.is(errorSchema)
  const isAuthorizationFailure = Option.match(policy, { onNone: Function.constant(alwaysUndeclared), onSome: Function.constant(isMiddlewareFailure) })
  const isDeclared = (value: unknown) => isContractFailure(value) || isAuthorizationFailure(value)

  const translate = (cause: Cause.Cause<unknown>) => pipe(
    declaredFailure(isDeclared, cause),
    Option.match({
      onNone: () => pipe(
        Effect.logError("Command failed with an undeclared error"),
        Effect.annotateLogs({
          "error.type": "undeclared",
          "operation.name": definition.name,
        }),
        Effect.andThen(fallback),
      ),
      onSome: Effect.fail,
    }),
  )

  const handler = flow(run, Effect.catchCause(translate), Effect.withSpan(definition.name))

  return {
    spec: definition,
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    rpc: rpc as Procedure<Spec["name"], Payload, Success, ErrorSchema, Policy>,
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    handler: handler as (input: PayloadType<Payload>) => Effect.Effect<
      Success["Type"],
      Failure,
      Exclude<HandlerRequirements<Implementation>, AuthorizationSubject>
        | (Transaction extends true ? RepositoryStore : never)
    >,
  } satisfies CommandLive
}

const defineFamily = <
  const Prefix extends string,
  const Unavailable extends Schema.Constraint,
  const Policy extends SubjectPolicy | undefined,
  const Transaction extends boolean | undefined,
>(
  prefix: Prefix,
  unavailable: Unavailable & NoInfer<UnavailableConstructor<Unavailable>>,
  policy: Policy,
  transaction: Transaction,
) => {
  const define = <
    const Name extends string,
    const Success extends Schema.Constraint,
    const Payload extends Schema.Constraint | undefined = undefined,
    const Errors extends Schema.Constraint | undefined = undefined,
  >(
    definition: Readonly<{
      name: Name
      success: Success
    }> & Readonly<Partial<{
      errors: Errors
      payload: Payload
      dependencies: ReadonlyArray<CommandDependency>
    }>>,
  ): CommandSpec<
    `${Prefix}${Name}`,
    Payload,
    Success,
    Errors,
    Unavailable,
    Policy,
    Transaction
  > => {
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    const name = `${prefix}${definition.name}` as `${Prefix}${Name}`

    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    return Object.freeze({
      ...definition,
      name,
      unavailable,
      policy,
      transaction,
    }) as CommandSpec<`${Prefix}${Name}`, Payload, Success, Errors, Unavailable, Policy, Transaction>
  }

  return { define }
}

const family = <
  const Prefix extends string,
  const Unavailable extends Schema.Constraint,
>(
  prefix: Prefix,
  unavailable: Unavailable & NoInfer<UnavailableConstructor<Unavailable>>,
) => {
  const base = defineFamily(prefix, unavailable, undefined, undefined)
  const transactional = () => defineFamily(prefix, unavailable, undefined, true)

  const authorized = <const Policy extends SubjectPolicy>(policy: Policy) => {
    const scoped = defineFamily(prefix, unavailable, policy, undefined)
    const transactional = () => defineFamily(prefix, unavailable, policy, true)

    return { ...scoped, transactional }
  }

  return { ...base, authorized, transactional }
}


type CommandContract<Commands extends ReadonlyArray<CommandLive>> =
  Commands[number]["rpc"]

type CommandRequirements<Commands extends ReadonlyArray<CommandLive>> =
  Exclude<
    Effect.Services<ReturnType<Commands[number]["handler"]>>,
    AuthorizationSubject
  >



export interface AnyCommandBundle extends RpcBundle {
  readonly commands: ReadonlyArray<CommandLive>
}

type CommandBundle<
  Commands extends ReadonlyArray<CommandLive> = ReadonlyArray<CommandLive>,
> = Readonly<{
  readonly commands: Commands
  readonly group: RpcGroup.RpcGroup<CommandContract<Commands>>
  readonly handlers: Layer.Layer<
    Rpc.ToHandler<CommandContract<Commands>>,
    never,
    CommandRequirements<Commands>
  >
}>

const bundle = <const Commands extends ReadonlyArray<CommandLive>>(
  ...commands: Commands
): CommandBundle<Commands> => {
  type Contract = CommandContract<Commands>
  type Requirements = CommandRequirements<Commands>

  const rpcs: ReadonlyArray<Contract> = Array.map(commands, Struct.get("rpc"))
  const group = RpcGroup.make(...rpcs)

  const install = (command: CommandLive<Contract>) =>
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    group.toLayerHandler(command.rpc._tag, command.handler as RpcGroup.HandlerFrom<Contract, Contract["_tag"]>)

  const layers = Array.map(commands, install)
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const handlers = Layer.mergeAll(Layer.empty, ...layers) as Layer.Layer<Rpc.ToHandler<Contract>, never, Requirements>
  const frozenCommands = Object.freeze(commands)
  const rpcBundle = RpcBundle.make(group)(handlers)

  return Struct.assign(rpcBundle, {
    commands: frozenCommands,
  }) satisfies AnyCommandBundle
}

export const Command = {
  define: defineCommand,
  implement: compileCommand,
  family,
  bundle,
  dependencies: dependencySet,
}
