import { Effect, Layer, Schema } from "effect"
import { Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc"
import type { AnyCommandBundle } from "./commands.ts"
import { SchemaStore } from "./migrations.ts"
import type { Resource } from "./resource.ts"
import { Table } from "./table.ts"

type HandlerLayer<Bundle> = Bundle extends {
  readonly handlers: infer Handlers extends Layer.Layer<any, any, any>
} ? Handlers : never

type ApplicationGroup<
  Resources extends ReadonlyArray<Resource>,
  Commands extends ReadonlyArray<AnyCommandBundle>,
> = RpcGroup.RpcGroup<RpcGroup.Rpcs<Resources[number]["group"] | Commands[number]["group"]>>

class ApplicationDefinitionError extends Schema.TaggedError<ApplicationDefinitionError>()(
  "ApplicationDefinitionError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

const make = <
  const Resources extends ReadonlyArray<Resource> = [],
  const Commands extends ReadonlyArray<AnyCommandBundle> = [],
>(options: Readonly<{
  name: string
  resources?: Resources
  commands?: Commands
}>) => {
  const resources = options.resources ?? ([] as unknown as Resources)
  const commands = options.commands ?? ([] as unknown as Commands)
  const bundles = [...resources, ...commands]
  const groups = bundles.map((bundle) => bundle.group) as Array<RpcGroup.RpcGroup<Rpc.Any>>
  const tables = resources.map((resource) => resource.table) as Array<Resources[number]["table"]>
  const tableNames = new Set<string>()
  const operationNames = new Set<string>()

  for (const table of tables) {
    if (tableNames.has(table.name)) {
      throw ApplicationDefinitionError.make({ reason: `Duplicate resource table ${table.name}` })
    }
    tableNames.add(table.name)
  }
  for (const group of groups) {
    for (const procedure of group.requests.values()) {
      if (operationNames.has(procedure._tag)) {
        throw ApplicationDefinitionError.make({ reason: `Duplicate operation ${procedure._tag}` })
      }
      if (RpcSchema.isStreamSchema((procedure as Rpc.AnyWithProps).successSchema)) {
        throw ApplicationDefinitionError.make({ reason: `Application commands must be unary: ${procedure._tag}` })
      }
      operationNames.add(procedure._tag)
    }
  }

  const group = RpcGroup.make().merge(...groups) as ApplicationGroup<Resources, Commands>
  const layers = bundles.map((bundle) => bundle.handlers) as Array<HandlerLayer<Resources[number] | Commands[number]>>
  const handlers = (layers.length === 0 ? Layer.empty : Layer.mergeAll(layers[0]!, ...layers.slice(1))) as Layer.Layer<
    Layer.Success<(typeof layers)[number]>,
    Layer.Error<(typeof layers)[number]>,
    Layer.Services<(typeof layers)[number]>
  >
  const snapshots = tables.map(Table.snapshot)
  const prepare = Effect.flatMap(SchemaStore, (store) => store.prepare(snapshots))

  return { name: options.name, resources, commands, group, tables, handlers, prepare }
}

export type Application = ReturnType<typeof make>
export const Application = { make }
