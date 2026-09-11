import { Array, Cause, Effect, Equivalence, Function, Layer, Option, Record, Schema, Struct, flow, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { AuthorizationSubject, type SubjectPolicy } from "./authorization.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { RepositoryStore } from "./repository-store.ts"
import type { RpcBundle, RpcProcedure } from "./rpc-contract.ts"
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
  handler: Handler<Payload, Success, Policy, Failure, Requirements>
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
const emptyBundle = Record.empty<string, never>()

const inTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  pipe(RepositoryStore, Effect.flatMap((store) => store.transaction(effect)))

// Only a lone declared failure passes through because interruptions and defects are never part of the contract.
const declaredFailure = <Error extends Schema.Constraint>(schema: Error, cause: Cause.Cause<unknown>) => {
  const isDeclared = Schema.is(schema)
  const single = equals(cause.reasons.length, 1)

  const declared = (reason: Cause.Reason<unknown>) => Cause.isFailReason(reason) && isDeclared(reason.error)
    ? Option.some(reason.error)
    : Option.none<Error["Type"]>()

  const head = Array.head(cause.reasons)
  return single ? Option.flatMap(head, declared) : Option.none<Error["Type"]>()
}

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

  const translate = (cause: Cause.Cause<unknown>) => pipe(
    declaredFailure(definition.error, cause),
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
  return Struct.assign(emptyBundle, { group, handlers }) satisfies RpcBundle
}

export const Operation = { make, bundle }
