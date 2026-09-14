import { Array, Cause, Effect, Equivalence, Function, Layer, Match, Option, Record, Schema, Struct, flow, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import type { SqlError } from "effect/unstable/sql"
import { AuthorizationSubject, type SubjectPolicy } from "./authorization.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { RepositoryError, RepositoryStore, ResourceNotFound, UniqueViolation, VersionConflict } from "./repository-store.ts"
import { RpcBundle, type RpcProcedure } from "./rpc-contract.ts"
import { Resource, type AnyResourceSpec, type Resource as CompiledResource } from "./resource.ts"
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

type OperationRequirements<Transaction extends boolean | undefined, Requirements> =
  | Exclude<Requirements, AuthorizationSubject>
  | (Transaction extends true ? RepositoryStore : never)

/** The empty-field error class that replaces every failure the contract does not declare. */
interface UnavailableConstructor<Error extends Schema.Constraint> {
  readonly make: (fields: Record<string, never>) => Error["Type"]
}

type Tagged = Readonly<Record<"_tag", string>>

/** Failures the runtime owns; collapsing them into `unavailable` is the intended contract. */
type InfrastructureFailure =
  | SqlError.SqlError
  | Schema.SchemaError
  | RepositoryError
  | ResourceNotFound
  | UniqueViolation
  | VersionConflict
  | Cause.NoSuchElementError
  | Schema.Schema.Type<typeof AuthorizationRpc.errorSchema>

/**
 * Domain-tagged failures the handler can raise but the contract does not declare. Untagged
 * failures and infrastructure failures are allowed because `unavailable` exists for them.
 */
type UndeclaredFailure<Failure, Declared> = Failure extends Tagged
  ? Failure extends Declared | InfrastructureFailure ? never : Failure
  : never

type DeclaresEveryFailure<Failure, Declared> = [UndeclaredFailure<Failure, Declared>] extends [never]
  ? unknown
  : Readonly<{ undeclaredFailure: UndeclaredFailure<Failure, Declared> }>

type DeclaredFailure<Errors extends Schema.Constraint | undefined> =
  Errors extends Schema.Constraint ? Errors["Type"] : never

type OperationFailure<
  Errors extends Schema.Constraint | undefined,
  Unavailable extends Schema.Constraint,
> = DeclaredFailure<Errors> | Unavailable["Type"]

type OperationErrorSchema<
  Errors extends Schema.Constraint | undefined,
  Unavailable extends Schema.Constraint,
> = Schema.Codec<
  OperationFailure<Errors, Unavailable>,
  (Errors extends Schema.Constraint ? Errors["Encoded"] : never) | Unavailable["Encoded"],
  (Errors extends Schema.Constraint ? Errors["DecodingServices"] : never) | Unavailable["DecodingServices"],
  (Errors extends Schema.Constraint ? Errors["EncodingServices"] : never) | Unavailable["EncodingServices"]
>

export type CommandDependency =
  | AnyResourceSpec
  | CompiledResource
  | ReadModelSpec
  | CompiledReadModel
  | Table

export interface CommandDependencySet {
  readonly tables: ReadonlyArray<Table>
  readonly readModels: ReadonlyArray<ReadModelSpec | CompiledReadModel>
}

const dependencyTable = Match.type<AnyResourceSpec | Table>().pipe(
  Match.tagsExhaustive({
    ResourceSpec: Resource.table,
    Table: (table) => table,
  }),
)

const dependencyTables = Match.type<CommandDependency>().pipe(
  Match.tagsExhaustive({
    ResourceSpec: (dependency) => [Resource.table(dependency)],
    CompiledResource: (dependency) => [dependency.table],
    ReadModelSpec: (dependency) =>
      Array.map(Record.values(dependency.definition.tables), dependencyTable),
    CompiledReadModel: (dependency) => dependency.dependencies,
    Table: (dependency) => [dependency],
  }),
)

const isReadModel = (
  dependency: CommandDependency,
): dependency is ReadModelSpec | CompiledReadModel =>
  dependency._tag === "ReadModelSpec" || dependency._tag === "CompiledReadModel"

const dependencySet = (
  dependencies: ReadonlyArray<CommandDependency>,
): CommandDependencySet => {
  const readModels = Array.filter(dependencies, isReadModel)
  const declaredTables = Array.flatMap(dependencies, dependencyTables)
  const tables = Array.dedupeWith(
    declaredTables,
    Equivalence.strictEqual<Table>(),
  )

  return Object.freeze({
    tables: Object.freeze([...tables]),
    readModels: Object.freeze([...readModels]),
  })
}

export interface CommandSpec<
  Name extends string = string,
  Payload extends Schema.Constraint | undefined = Schema.Constraint | undefined,
  Success extends Schema.Constraint = Schema.Constraint,
  Errors extends Schema.Constraint | undefined = Schema.Constraint | undefined,
  Unavailable extends Schema.Constraint = Schema.Constraint,
  Policy extends SubjectPolicy | undefined = SubjectPolicy | undefined,
  Transaction extends boolean | undefined = boolean | undefined,
> {
  readonly _tag: "CommandSpec"
  readonly name: Name
  readonly success: Success
  readonly unavailable: Unavailable & UnavailableConstructor<Unavailable>
  readonly errors?: Errors
  readonly payload?: Payload
  readonly policy?: Policy
  readonly transaction?: Transaction
  readonly dependencies?: ReadonlyArray<CommandDependency>
  readonly _types?: Readonly<{
    payload: Payload
    success: Success
    errors: Errors
    unavailable: Unavailable
    policy: Policy
    transaction: Transaction
  }>
}

type CommandDefinition<
  Name extends string,
  Payload extends Schema.Constraint | undefined,
  Success extends Schema.Constraint,
  Errors extends Schema.Constraint | undefined,
  Unavailable extends Schema.Constraint,
  Policy extends SubjectPolicy | undefined,
  Transaction extends boolean | undefined,
> = Omit<
  CommandSpec<Name, Payload, Success, Errors, Unavailable, Policy, Transaction>,
  "_tag"
>

type AnyCommandFamilyDefinition = Readonly<{
  name: string
  success: Schema.Constraint
}> & Readonly<Partial<{
  errors: Schema.Constraint
  payload: Schema.Constraint
  dependencies: ReadonlyArray<CommandDependency>
}>>

type FamilyPayload<Definition> =
  Definition extends { readonly payload: infer Payload extends Schema.Constraint }
    ? Payload
    : undefined

type FamilyErrors<Definition> =
  Definition extends { readonly errors: infer Errors extends Schema.Constraint }
    ? Errors
    : undefined

const defineCommand = <
  const Name extends string,
  const Payload extends Schema.Constraint | undefined = undefined,
  const Success extends Schema.Constraint = typeof Schema.Void,
  const Errors extends Schema.Constraint | undefined = undefined,
  const Unavailable extends Schema.Constraint = typeof Schema.Never,
  const Policy extends SubjectPolicy | undefined = undefined,
  const Transaction extends boolean | undefined = undefined,
>(
  definition: CommandDefinition<
    Name,
    Payload,
    Success,
    Errors,
    Unavailable,
    Policy,
    Transaction
  >,
): CommandSpec<
  Name,
  Payload,
  Success,
  Errors,
  Unavailable,
  Policy,
  Transaction
> => Object.freeze({ ...definition, _tag: "CommandSpec" as const })


/** A command specification paired with its translated Effect implementation. */
export interface CommandLive<Contract extends RpcProcedure = RpcProcedure> {
  readonly _tag: "CommandLive"
  readonly spec: CommandSpec
  readonly rpc: Contract
  readonly handler: (input: never) => Effect.Effect<unknown, unknown, unknown>
}

const equals = Equivalence.strictEqual<number>()

const inTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  pipe(RepositoryStore, Effect.flatMap((store) => store.transaction(effect)))

// Only a lone declared failure passes through because interruptions and defects are never part of the contract.
const declaredFailure = (isDeclared: (value: unknown) => boolean, cause: Cause.Cause<unknown>) => {
  const single = equals(cause.reasons.length, 1)

  const declared = (reason: Cause.Reason<unknown>) => Cause.isFailReason(reason) && isDeclared(reason.error)
    ? Option.some(reason.error)
    : Option.none<unknown>()

  const head = Array.head(cause.reasons)
  return single ? Option.flatMap(head, declared) : Option.none<unknown>()
}

// Protected operations pass authorization failures through because the middleware already publishes them.
const isMiddlewareFailure = Schema.is(AuthorizationRpc.errorSchema)
const alwaysUndeclared = Function.constant(false)

type CommandTypes<Spec extends CommandSpec> = NonNullable<Spec["_types"]>


const compileCommand = <
  const Spec extends CommandSpec,
  const Implementation = never,
>(
  definition: Spec,
  implementation: Implementation & NoInfer<
    Handler<
      CommandTypes<Spec>["payload"],
      CommandTypes<Spec>["success"],
      CommandTypes<Spec>["policy"],
      HandlerFailure<Implementation>,
      HandlerRequirements<Implementation>
    >
      & DeclaresEveryFailure<
        HandlerFailure<Implementation>,
        OperationFailure<CommandTypes<Spec>["errors"], CommandTypes<Spec>["unavailable"]>
      >
  >,
) => {
  type Payload = CommandTypes<Spec>["payload"]
  type Success = CommandTypes<Spec>["success"]
  type Errors = CommandTypes<Spec>["errors"]
  type Unavailable = CommandTypes<Spec>["unavailable"]
  type Policy = CommandTypes<Spec>["policy"]
  type Transaction = CommandTypes<Spec>["transaction"]
  const payload = Option.fromNullishOr(definition.payload)
  const payloadSchema = Option.getOrElse(payload, Function.constant(Schema.Void))
  const payloadJsonSchema = Schema.toCodecJson(payloadSchema)
  const successJsonSchema = Schema.toCodecJson(definition.success)
  const declaredErrors = Option.fromNullishOr(definition.errors)

  const errorSchema = Option.match(declaredErrors, {
    onNone: () => definition.unavailable,
    onSome: (errors) => Schema.Union([errors, definition.unavailable]),
  }) as OperationErrorSchema<Errors, Unavailable>

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
    onNone: () => (implementation as UnprotectedHandler<
      Payload,
      Success,
      HandlerFailure<Implementation>,
      HandlerRequirements<Implementation>
    >)(input),
    onSome: () => pipe(
      AuthorizationSubject,
      Effect.flatMap((subject) => (implementation as ProtectedHandler<
        Payload,
        Success,
        Policy,
        HandlerFailure<Implementation>,
        HandlerRequirements<Implementation>
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
      onNone: () => pipe(Effect.logError(cause), Effect.andThen(fallback)),
      onSome: Effect.fail,
    }),
  )

  const handler = flow(run, Effect.catchCause(translate), Effect.withSpan(definition.name))

  return {
    _tag: "CommandLive" as const,
    spec: definition,
    rpc: rpc as Procedure<Spec["name"], Payload, Success, OperationErrorSchema<Errors, Unavailable>, Policy>,
    handler: handler as (input: PayloadType<Payload>) => Effect.Effect<
      Success["Type"],
      OperationFailure<Errors, Unavailable>,
      OperationRequirements<Transaction, HandlerRequirements<Implementation>>
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
  const define = <const Definition extends AnyCommandFamilyDefinition>(
    definition: Definition,
  ): CommandSpec<
    `${Prefix}${Definition["name"]}`,
    FamilyPayload<Definition>,
    Definition["success"],
    FamilyErrors<Definition>,
    Unavailable,
    Policy,
    Transaction
  > => {
    const name = `${prefix}${definition.name}` as `${Prefix}${Definition["name"]}`

    return defineCommand({
      name,
      success: definition.success,
      errors: definition.errors,
      payload: definition.payload,
      dependencies: definition.dependencies,
      unavailable,
      policy,
      transaction,
    } as CommandDefinition<
      `${Prefix}${Definition["name"]}`,
      FamilyPayload<Definition>,
      Definition["success"],
      FamilyErrors<Definition>,
      Unavailable,
      Policy,
      Transaction
    >)
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
  readonly _tag: "CommandBundle"
  readonly commands: ReadonlyArray<CommandLive>
}

export type CommandBundle<
  Commands extends ReadonlyArray<CommandLive> = ReadonlyArray<CommandLive>,
> = Readonly<{
  readonly _tag: "CommandBundle"
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
    group.toLayerHandler(command.rpc._tag, command.handler as RpcGroup.HandlerFrom<Contract, Contract["_tag"]>)

  const layers = Array.map(commands, install)
  const handlers = Layer.mergeAll(Layer.empty, ...layers) as Layer.Layer<Rpc.ToHandler<Contract>, never, Requirements>
  return Object.freeze({
    _tag: "CommandBundle" as const,
    commands: Object.freeze([...commands]) as unknown as Commands,
    group,
    handlers,
  })
}

export const Command = {
  define: defineCommand,
  implement: compileCommand,
  family,
  bundle,
  dependencies: dependencySet,
}
