import { Array, Effect, HashSet, Layer, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup, RpcMiddleware, RpcSchema } from "effect/unstable/rpc"
import { SchemaStore } from "./migrations.ts"
import type { Resource } from "./resource.ts"
import { Table } from "./table.ts"

export type CommandService<Group extends RpcGroup.Any> = {
  readonly [Procedure in RpcGroup.Rpcs<Group> as Procedure["_tag"]]:
    Procedure extends Rpc.AnyWithProps
      ? (input: Procedure["payloadSchema"]["Type"]) => Effect.Effect<
          Procedure["successSchema"]["Type"],
          Procedure["errorSchema"]["Type"],
          unknown
        >
      : never
}

class ApplicationDefinitionError extends Schema.TaggedError<ApplicationDefinitionError>()(
  "ApplicationDefinitionError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

const toJsonCodecRpc = <
  Tag extends string,
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Middleware extends RpcMiddleware.AnyService,
  Requires,
>(procedure: Rpc.Rpc<Tag, Payload, Success, Error, Middleware, Requires>) => {
  const payloadSchema = Schema.toCodecJson(procedure.payloadSchema)
  const successSchema = Schema.toCodecJson(procedure.successSchema)
  const errorSchema = Schema.toCodecJson(procedure.errorSchema)
  const withPayload = procedure.setPayload(payloadSchema)
  const withSuccess = withPayload.setSuccess(successSchema)
  return withSuccess.setError(errorSchema)
}

const toJsonCodecGroup = (group: RpcGroup.RpcGroup<any>) => {
  const requests = group.requests.values()
  const procedures = Array.fromIterable(requests)

  const codecProcedures = Array.map(
    procedures,
    toJsonCodecRpc as (procedure: (typeof procedures)[number]) => ReturnType<typeof toJsonCodecRpc>,
  )

  const codecGroup = RpcGroup.make(...codecProcedures)
  return codecGroup.annotateMerge(group.annotations)
}

const proceduresFromRequests = (
  requests: RpcGroup.RpcGroup<Rpc.Any>["requests"],
) => pipe(requests.values(), Array.fromIterable)

const duplicateOperation = (procedure: Rpc.Any) =>
  ApplicationDefinitionError.make({ reason: `Duplicate operation ${procedure._tag}` })

const streamingOperation = (procedure: Rpc.Any) =>
  ApplicationDefinitionError.make({
    reason: `Application commands must be unary: ${procedure._tag}`,
  })

const validateProcedure = Effect.fn("Application.validateProcedure")(
  function* (tags: HashSet.HashSet<string>, procedure: Rpc.Any) {
    if (HashSet.has(tags, procedure._tag)) {
      const error = duplicateOperation(procedure)
      return yield* Effect.fail(error)
    }

    if (RpcSchema.isStreamSchema((procedure as Rpc.AnyWithProps).successSchema)) {
      const error = streamingOperation(procedure)
      return yield* Effect.fail(error)
    }

    return HashSet.add(tags, procedure._tag)
  },
)

const ApplicationResourcesSchema = Schema.Array(Schema.Any)

export class Application extends Schema.Class<Application>("Application")({
  name: Schema.String,
  resources: ApplicationResourcesSchema,
  commands: Schema.Any,
  group: Schema.Any,
  tables: Schema.Any,
  handlers: Schema.Any,
  prepare: Schema.Any,
  toLayer: Schema.Any,
}) {
  static override make<
    const Resources extends ReadonlyArray<Resource>,
    Commands extends Rpc.Any,
  >(
    options: Readonly<{
      name: string
      resources: Resources
      commands: RpcGroup.RpcGroup<any>
    }>,
  ) {
    const resourceGroups = Array.map(options.resources, Struct.get("group"))

    const groups: ReadonlyArray<Pick<RpcGroup.RpcGroup<Rpc.Any>, "requests">> = Array.prepend(
      resourceGroups,
      options.commands,
    )

    const validation = Effect.gen(function* () {

      const resources = yield* Effect.reduce(
        options.resources,
        HashSet.empty<string>,
        (tables, resource) => {
          if (HashSet.has(tables, resource.table.name)) {
            const error = ApplicationDefinitionError.make({
              reason: `Duplicate resource table ${resource.table.name}`,
            })

            return Effect.fail(error)
          }

          const updatedTables = HashSet.add(tables, resource.table.name)

          return Effect.succeed(updatedTables)
        },
      )

      const requestGroups = Array.map(groups, Struct.get("requests"))
      const procedures = Array.flatMap(requestGroups, proceduresFromRequests)

      yield* Effect.reduce(procedures, HashSet.empty<string>, validateProcedure)
      return resources
    })

    Effect.runSync(validation)

    const group = toJsonCodecGroup(options.commands).merge(...resourceGroups)
    const tables = Array.map(options.resources, Struct.get("table")) as Array<Resources[number]["table"]>
    const snapshots = Array.map(tables, Table.snapshot)
    const layers = Array.map(options.resources, Struct.get("handlers")) as Array<Resources[number]["handlers"]>

    const handlers = (
      Array.isArrayNonEmpty(layers) ? Layer.mergeAll(...layers) : Layer.empty
    ) as Layer.Layer<
      Layer.Success<Resources[number]["handlers"]>,
      Layer.Error<Resources[number]["handlers"]>,
      Layer.Services<Resources[number]["handlers"]>
    >

    const prepare = Effect.gen(function* () {
      const store = yield* SchemaStore
      yield* store.prepare(snapshots)
    })

    const toLayer = (implementation: any) => {
      const implementationLayer = options.commands.toLayer(implementation)
      return Layer.provideMerge(implementationLayer, handlers)
    }

    return super.make({
      name: options.name,
      resources: options.resources,
      commands: options.commands,
      group,
      tables,
      handlers,
      prepare,
      toLayer,
    }) as Struct.Assign<Application, {
      name: string
      resources: Resources
      commands: RpcGroup.RpcGroup<Commands>
      group: ReturnType<typeof toJsonCodecGroup>
      tables: Array<Resources[number]["table"]>
      handlers: typeof handlers
      prepare: typeof prepare
      toLayer: typeof toLayer
    }>
  }
}
