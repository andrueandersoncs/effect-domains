import { Array, Data, type Layer, Option, Schema, Struct } from "effect"
import { Rpc, type RpcGroup, type RpcMiddleware, RpcSchema } from "effect/unstable/rpc"

// Inspect only middleware errors because their service implementations are contravariant.
export type RpcProcedure = Rpc.Any & Pick<Rpc.AnyWithProps, "payloadSchema" | "successSchema" | "errorSchema"> & Readonly<{
  middlewares: Iterable<Pick<RpcMiddleware.AnyServiceWithProps, "error">>
}>

export type RpcBundle = Readonly<{
  group: RpcGroup.Any & Pick<RpcGroup.RpcGroup<RpcProcedure>, "requests">
  handlers: Layer.Layer<never, any, any>
}>

class CompiledRpcBundle<
  Group extends RpcBundle["group"],
  Handlers extends RpcBundle["handlers"],
> extends Data.Class<Readonly<{
  group: Group
  handlers: Handlers
}>> {}

// Build bundles here because the pair is a boundary value shared by resources, commands, and identity.
const make = <Group extends RpcBundle["group"]>(group: Group) =>
  <Handlers extends RpcBundle["handlers"]>(handlers: Handlers) =>
    new CompiledRpcBundle<Group, Handlers>({ group, handlers })

export const RpcBundle = { make }

export const compileUnaryRpc = (procedure: RpcProcedure) => {
  if (RpcSchema.isStreamSchema(procedure.successSchema)) return Option.none()

  const middlewares = Array.fromIterable(procedure.middlewares)
  const middlewareErrors = Array.map(middlewares, Struct.get("error"))
  const errors = [procedure.errorSchema, ...middlewareErrors] as const
  const payloadSchema = Schema.toCodecJson(procedure.payloadSchema)
  const successSchema = Schema.toCodecJson(procedure.successSchema)
  const ErrorUnionSchema = Schema.Union(errors)
  const errorSchema = Schema.toCodecJson(ErrorUnionSchema)

  const compiled = Rpc.make(procedure._tag, {
    payload: payloadSchema, success: successSchema, error: errorSchema,
  }).annotateMerge(procedure.annotations)

  return Option.some(compiled)
}
