import { Array, Option, Schema, Struct } from "effect"
import { RpcSchema } from "effect/unstable/rpc"

export interface UnaryRpcProcedure {
  readonly _tag: string
  readonly payloadSchema: Schema.Constraint
  readonly successSchema: Schema.Constraint
  readonly errorSchema: Schema.Constraint
  readonly middlewares: Iterable<Readonly<{ readonly error: Schema.Constraint }>>
}

interface UnaryRpcContract {
  readonly tag: string
  readonly payload: Schema.Constraint
  readonly success: Schema.Constraint
  readonly error: Schema.Constraint
}

export const compileUnaryRpc = <Procedure extends UnaryRpcProcedure>(procedure: Procedure): Option.Option<UnaryRpcContract> => {
  if (RpcSchema.isStreamSchema(procedure.successSchema)) return Option.none()

  const middlewares = Array.fromIterable(procedure.middlewares)
  const middlewareErrors = Array.map(middlewares, Struct.get("error"))
  const errors = [procedure.errorSchema, ...middlewareErrors] as const
  const payloadSchema = Schema.toCodecJson(procedure.payloadSchema)
  const successSchema = Schema.toCodecJson(procedure.successSchema)
  const errorSchema = Schema.toCodecJson(Schema.Union(errors))
  return Option.some({ tag: procedure._tag, payload: payloadSchema, success: successSchema, error: errorSchema })
}
