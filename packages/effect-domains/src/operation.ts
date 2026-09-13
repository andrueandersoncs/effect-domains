import { Array, Cause, Context, Effect, Equivalence, Function, Layer, Option, Record, Schema, Struct, flow, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import type { SqlError } from "effect/unstable/sql"
import { AuthorizationSubject, type SubjectPolicy } from "./authorization.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { RepositoryError, RepositoryStore, ResourceNotFound, UniqueViolation, VersionConflict } from "./repository-store.ts"
import { RpcBundle, type RpcProcedure } from "./rpc-contract.ts"
import type { Resource } from "./resource.ts"
import type { SqliteView } from "./sqlite-view.ts"
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

type OperationDependency = Resource | Table | SqliteView

interface OperationDependencySet {
  readonly tables: ReadonlyArray<Table>
  readonly views: ReadonlyArray<SqliteView>
}

export class OperationDependencies extends Context.Service<
  OperationDependencies,
  OperationDependencySet
>()("@effect-domains/OperationDependencies") {}

const isView = (dependency: OperationDependency): dependency is SqliteView => "description" in dependency
const isResource = (dependency: OperationDependency): dependency is Resource => "table" in dependency

const dependenciesFrom = (dependency: OperationDependency): ReadonlyArray<Table> => {
  if (isView(dependency)) return dependency.dependencies
  return isResource(dependency) ? [dependency.table] : [dependency]
}

const dependencySet = (dependencies: ReadonlyArray<OperationDependency>): OperationDependencySet => {
  const views = Array.filter(dependencies, isView)
  const declaredTables = Array.flatMap(dependencies, dependenciesFrom)
  const tables = Array.dedupeWith(declaredTables, Equivalence.strictEqual<Table>())
  const frozenTables = Object.freeze([...tables])
  const frozenViews = Object.freeze([...views])

  return Object.freeze({ tables: frozenTables, views: frozenViews })
}

type OperationDefinition<
  Name extends string,
  Payload extends Schema.Constraint | undefined,
  Success extends Schema.Constraint,
  Errors extends Schema.Constraint | undefined,
  Unavailable extends Schema.Constraint,
  Policy extends SubjectPolicy | undefined,
  Transaction extends boolean | undefined,
  Failure,
  Requirements,
> = Readonly<{
  name: Name
  success: Success
  unavailable: Unavailable & UnavailableConstructor<Unavailable>
  handler: Handler<Payload, Success, Policy, Failure, Requirements>
    & DeclaresEveryFailure<Failure, OperationFailure<Errors, Unavailable>>
}> & Readonly<Partial<{
  errors: Errors
  payload: Payload
  policy: Policy
  transaction: Transaction
  dependencies: ReadonlyArray<OperationDependency>
}>>

type OperationFamilyDefinition<
  Name extends string,
  Payload extends Schema.Constraint | undefined,
  Success extends Schema.Constraint,
  Errors extends Schema.Constraint | undefined,
  Unavailable extends Schema.Constraint,
  Policy extends SubjectPolicy | undefined,
  Transaction extends boolean | undefined,
  Failure,
  Requirements,
> = Readonly<{
  name: Name
  success: Success
  handler: Handler<Payload, Success, Policy, Failure, Requirements>
    & DeclaresEveryFailure<Failure, OperationFailure<Errors, Unavailable>>
}> & Readonly<Partial<{
  errors: Errors
  payload: Payload
  dependencies: ReadonlyArray<OperationDependency>
}>>


/** A compiled contract with its translated handler; `bundle` installs many at once. */
export interface Operation<Contract extends RpcProcedure = RpcProcedure> {
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

const make = <
  const Name extends string,
  const Payload extends Schema.Constraint | undefined = undefined,
  const Success extends Schema.Constraint = typeof Schema.Void,
  const Errors extends Schema.Constraint | undefined = undefined,
  const Unavailable extends Schema.Constraint = typeof Schema.Never,
  const Policy extends SubjectPolicy | undefined = undefined,
  const Transaction extends boolean | undefined = undefined,
  Failure = never,
  Requirements = never,
>(definition: OperationDefinition<Name, Payload, Success, Errors, Unavailable, Policy, Transaction, Failure, Requirements>) => {
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
  const dependencies = Option.fromNullishOr(definition.dependencies)

  const annotate = (declared: ReadonlyArray<OperationDependency>) => {
    const declaredDependencies = dependencySet(declared)
    return contract.annotate(OperationDependencies, declaredDependencies)
  }

  const annotated = Option.match(dependencies, {
    onNone: Function.constant(contract),
    onSome: annotate,
  })

  const policy = Option.fromNullishOr(definition.policy)

  const rpc = Option.match(policy, {
    onNone: Function.constant(annotated),
    onSome: (subjectPolicy) => annotated.middleware(AuthorizationRpc).annotate(AuthorizationRpc.policy, subjectPolicy),
  })

  const transaction = Option.fromNullishOr(definition.transaction)
  const transactional = Option.getOrElse(transaction, Function.constant(false))

  const invoke = (input: PayloadType<Payload>) => Option.match(policy, {
    onNone: () => (definition.handler as UnprotectedHandler<Payload, Success, Failure, Requirements>)(input),
    onSome: () => pipe(
      AuthorizationSubject,
      Effect.flatMap((subject) => (definition.handler as ProtectedHandler<Payload, Success, Policy, Failure, Requirements>)(input, subject as SubjectType<Policy>)),
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
    rpc: rpc as Procedure<Name, Payload, Success, OperationErrorSchema<Errors, Unavailable>, Policy>,
    handler: handler as (input: PayloadType<Payload>) => Effect.Effect<Success["Type"], OperationFailure<Errors, Unavailable>, OperationRequirements<Transaction, Requirements>>,
  } satisfies Operation
}

const defineFamily = <
  const Prefix extends string,
  const Unavailable extends Schema.Constraint,
  const Policy extends SubjectPolicy | undefined,
  const Transaction extends boolean | undefined,
>(
  prefix: Prefix,
  unavailable: Unavailable & UnavailableConstructor<Unavailable>,
  policy: Policy,
  transaction: Transaction,
) => {
  const define = <
    const Name extends string,
    const Payload extends Schema.Constraint | undefined = undefined,
    const Success extends Schema.Constraint = typeof Schema.Void,
    const Errors extends Schema.Constraint | undefined = undefined,
    Failure = never,
    Requirements = never,
  >(definition: OperationFamilyDefinition<Name, Payload, Success, Errors, Unavailable, Policy, Transaction, Failure, Requirements>) => {
    const name = `${prefix}${definition.name}` as `${Prefix}${Name}`

    return make({
      name,
      success: definition.success,
      handler: definition.handler,
      errors: definition.errors,
      payload: definition.payload,
      dependencies: definition.dependencies,
      unavailable,
      policy,
      transaction,
    } as OperationDefinition<`${Prefix}${Name}`, Payload, Success, Errors, Unavailable, Policy, Transaction, Failure, Requirements>)
  }

  return { make: define }
}

const family = <
  const Prefix extends string,
  const Unavailable extends Schema.Constraint,
>(
  prefix: Prefix,
  unavailable: Unavailable & UnavailableConstructor<Unavailable>,
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

const listOperation = <
  const Name extends string,
  const Payload extends Schema.Constraint,
  const Success extends Schema.Constraint,
  const Errors extends Schema.Constraint,
  const Unavailable extends Schema.Constraint,
  Failure,
  Requirements,
>(definition: Readonly<{
  name: Name
  unavailable: Unavailable & UnavailableConstructor<Unavailable>
  list: Readonly<{
    payload: Payload
    success: Success
    errors: Errors
    dependencies: ReadonlyArray<SqliteView>
    handler: UnprotectedHandler<Payload, Success, Failure, Requirements>
      & DeclaresEveryFailure<Failure, OperationFailure<Errors, Unavailable>>
  }>
}>) => make({
  name: definition.name,
  unavailable: definition.unavailable,
  ...definition.list,
} as OperationDefinition<Name, Payload, Success, Errors, Unavailable, undefined, undefined, Failure, Requirements>)

const bundle = <const Operations extends ReadonlyArray<Operation>>(...operations: Operations) => {
  type Contract = Operations[number]["rpc"]
  type Requirements = Exclude<Effect.Services<ReturnType<Operations[number]["handler"]>>, AuthorizationSubject>
  const rpcs: ReadonlyArray<Contract> = Array.map(operations, Struct.get("rpc"))
  const group = RpcGroup.make(...rpcs)

  const install = (operation: Operation<Contract>) =>
    group.toLayerHandler(operation.rpc._tag, operation.handler as RpcGroup.HandlerFrom<Contract, Contract["_tag"]>)

  const layers = Array.map(operations, install)
  const handlers = Layer.mergeAll(Layer.empty, ...layers) as Layer.Layer<Rpc.ToHandler<Contract>, never, Requirements>
  return RpcBundle.make(group)(handlers)
}

export const Operation = { make, family, listOperation, bundle, annotation: OperationDependencies, dependencies: dependencySet }
