import { Array, Effect, HashSet, Layer, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc"
import type { AnyCommandBundle } from "./commands.ts"
import { SchemaStore } from "./migrations.ts"
import type { Resource } from "./resource.ts"
import { Table } from "./table.ts"

type ResourceRpcs<Resources extends ReadonlyArray<Resource>> =
  Resources[number] extends { readonly group: infer Group }
    ? RpcGroup.Rpcs<Group>
    : never

type CommandRpcs<Commands extends ReadonlyArray<AnyCommandBundle>> =
  RpcGroup.Rpcs<Commands[number]["group"]>


type HandlerLayer<Bundle> = Bundle extends {
  readonly handlers: infer Handlers extends Layer.Layer<any, any, any>
} ? Handlers : never
type CommandHandlerLayers<Commands extends ReadonlyArray<AnyCommandBundle>> = HandlerLayer<Commands[number]>
type ApplicationGroup<
  Resources extends ReadonlyArray<Resource>,
  Commands extends ReadonlyArray<AnyCommandBundle>,
> = RpcGroup.RpcGroup<CommandRpcs<Commands> | ResourceRpcs<Resources>>

class ApplicationDefinitionError extends Schema.TaggedError<ApplicationDefinitionError>()(
  "ApplicationDefinitionError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
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
}) {
  static override make<
    const Resources extends ReadonlyArray<Resource> = [],
    const Commands extends ReadonlyArray<AnyCommandBundle> = [],
  >(options: Readonly<{
    name: string
    resources?: Resources
    commands?: Commands
  }>) {
    const resources = options.resources ?? ([] as unknown as Resources)
    const commands = options.commands ?? ([] as unknown as Commands)
    const resourceGroups = Array.map(resources, Struct.get("group"))
    const commandGroups = Array.map(
      commands,
      Struct.get("group"),
    ) as Array<RpcGroup.RpcGroup<Rpc.Any>>
    const groups: ReadonlyArray<Pick<RpcGroup.RpcGroup<Rpc.Any>, "requests">> = [
      ...resourceGroups,
      ...commandGroups,
    ]

    const validation = Effect.gen(function* () {
      const resourceTables = yield* Effect.reduce(
        resources,
        HashSet.empty<string>,
        (tables, resource) => {
          if (HashSet.has(tables, resource.table.name)) {
            const error = ApplicationDefinitionError.make({
              reason: `Duplicate resource table ${resource.table.name}`,
            })

            return Effect.fail(error)
          }

          return Effect.succeed(HashSet.add(tables, resource.table.name))
        },
      )

      const requestGroups = Array.map(groups, Struct.get("requests"))
      const procedures = Array.flatMap(requestGroups, proceduresFromRequests)

      yield* Effect.reduce(procedures, HashSet.empty<string>, validateProcedure)
      return resourceTables
    })

    Effect.runSync(validation)

    const group = RpcGroup.make().merge(...resourceGroups, ...commandGroups) as ApplicationGroup<
      Resources,
      Commands
    >

    const tables = Array.map(resources, Struct.get("table")) as Array<Resources[number]["table"]>
    const snapshots = Array.map(tables, Table.snapshot)
    const resourceHandlers = Array.map(resources, Struct.get("handlers"))
    const commandHandlers = Array.map(
      commands,
      Struct.get("handlers"),
    ) as Array<CommandHandlerLayers<Commands>>
    const layers = [...resourceHandlers, ...commandHandlers]

    const handlers = (
      Array.isArrayNonEmpty(layers) ? Layer.mergeAll(...layers) : Layer.empty
    ) as Layer.Layer<
      Layer.Success<(typeof layers)[number]>,
      Layer.Error<(typeof layers)[number]>,
      Layer.Services<(typeof layers)[number]>
    >

    const prepare = Effect.gen(function* () {
      const store = yield* SchemaStore
      yield* store.prepare(snapshots)
    })

    return super.make({
      name: options.name,
      resources,
      commands,
      group,
      tables,
      handlers,
      prepare,
    }) as Struct.Assign<Application, {
      name: string
      resources: Resources
      commands: Commands
      group: ApplicationGroup<Resources, Commands>
      tables: Array<Resources[number]["table"]>
      handlers: typeof handlers
      prepare: typeof prepare
    }>
  }
}
