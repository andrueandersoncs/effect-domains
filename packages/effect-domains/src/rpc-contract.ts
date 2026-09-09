import { Option, Schema } from "effect"
import { RpcSchema } from "effect/unstable/rpc"

export interface UnaryRpcProcedure {
  readonly _tag: string
  readonly payloadSchema: Schema.Constraint
  readonly successSchema: Schema.Constraint
  readonly errorSchema: Schema.Constraint
  readonly middlewares: Iterable<Readonly<{ readonly error: Schema.Constraint }>>
}

export interface UnaryRpcContract {
  readonly tag: string
  readonly payload: Schema.Constraint
  readonly success: Schema.Constraint
  readonly error: Schema.Constraint
}

export const compileUnaryRpc = <Procedure extends UnaryRpcProcedure>(procedure: Procedure): Option.Option<UnaryRpcContract> => {
  if (RpcSchema.isStreamSchema(procedure.successSchema)) return Option.none()

  const errors: [Schema.Constraint, ...Array<Schema.Constraint>] = [procedure.errorSchema]
  for (const middleware of procedure.middlewares) errors.push(middleware.error)
  return Option.some({
    tag: procedure._tag,
    payload: Schema.toCodecJson(procedure.payloadSchema),
    success: Schema.toCodecJson(procedure.successSchema),
    error: Schema.toCodecJson(Schema.Union(errors)),
  })
}
