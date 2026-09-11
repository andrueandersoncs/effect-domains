import { Array, Cause, Effect, Equivalence, Function, Layer, Option, Record, Schema, Struct, flow, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import type { SqlError } from "effect/unstable/sql"
import { AuthorizationSubject, type SubjectPolicy } from "./authorization.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { RepositoryError, RepositoryStore, ResourceNotFound, UniqueViolation, VersionConflict } from "./repository-store.ts"
import { RpcBundle, type RpcProcedure } from "./rpc-contract.ts"
import { SqliteView } from "./sqlite-view.ts"

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

type DeclaresEveryFailure<Failure, Error extends Schema.Constraint> = [UndeclaredFailure<Failure, Error["Type"]>] extends [never]
  ? unknown
  : Readonly<{ undeclaredFailure: UndeclaredFailure<Failure, Error["Type"]> }>

type OperationDefinition<
  Name extends string,
  Payload extends Schema.Constraint | undefined,
  Success extends Schema.Constraint,
  Error extends Schema.Constraint,
  Policy extends SubjectPolicy | undefined,
  Transaction extends boolean | undefined,
  Failure,
  Requirements,
> = Readonly<{
  name: Name
  success: Success
  error: Error
  unavailable: UnavailableConstructor<Error>
  handler: Handler<Payload, Success, Policy, Failure, Requirements> & DeclaresEveryFailure<Failure, Error>
}> & Readonly<Partial<{
  payload: Payload
  policy: Policy
  transaction: Transaction
  views: ReadonlyArray<SqliteView>
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
  const Error extends Schema.Constraint = typeof Schema.Never,
  const Policy extends SubjectPolicy | undefined = undefined,
  const Transaction extends boolean | undefined = undefined,
  Failure = never,
  Requirements = never,
>(definition: OperationDefinition<Name, Payload, Success, Error, Policy, Transaction, Failure, Requirements>) => {
  const payload = Option.fromNullishOr(definition.payload)
  const payloadSchema = Option.getOrElse(payload, Function.constant(Schema.Void))
  const payloadJsonSchema = Schema.toCodecJson(payloadSchema)
  const successJsonSchema = Schema.toCodecJson(definition.success)
  const errorJsonSchema = Schema.toCodecJson(definition.error)
  const contract = Rpc.make(definition.name, { payload: payloadJsonSchema, success: successJsonSchema, error: errorJsonSchema })
  const views = Option.fromNullishOr(definition.views)

  const annotated = Option.match(views, {
    onNone: Function.constant(contract),
    onSome: (dependencies) => contract.annotate(SqliteView.annotation, dependencies),
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
  const isContractFailure = Schema.is(definition.error)
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
    rpc: rpc as Procedure<Name, Payload, Success, Error, Policy>,
    handler: handler as (input: PayloadType<Payload>) => Effect.Effect<Success["Type"], Error["Type"], OperationRequirements<Transaction, Requirements>>,
  } satisfies Operation
}

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

export const Operation = { make, bundle }
