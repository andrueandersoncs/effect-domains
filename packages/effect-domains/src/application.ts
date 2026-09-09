import { Array, Effect, HashSet, Layer, Schema, Struct, pipe } from "effect"
import { RpcGroup, RpcSchema } from "effect/unstable/rpc"
import type { AnyCommandBundle } from "./commands.ts"
import { SchemaStore } from "./migrations.ts"
import type { Resource } from "./resource.ts"
import { Table } from "./table.ts"

type HandlerLayer<Bundle> = Bundle extends {
  readonly handlers: infer Handlers extends Layer.Layer<never, any, any>
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

const emptyResources = [] as const satisfies ReadonlyArray<Resource>
const emptyCommands = [] as const satisfies ReadonlyArray<AnyCommandBundle>

const make = <
  const Resources extends ReadonlyArray<Resource> = typeof emptyResources,
  const Commands extends ReadonlyArray<AnyCommandBundle> = typeof emptyCommands,
>(options: Readonly<{
  name: string
}> & Readonly<Partial<{
  resources: Resources
  commands: Commands
}>>) => {
  const resources = options.resources ?? emptyResources
  const commands = options.commands ?? emptyCommands
  const bundles = [...resources, ...commands]
  const groups = Array.map(bundles, Struct.get("group"))
  const tables = Array.map(resources as ReadonlyArray<Resource>, Struct.get("table")) as Array<Resources[number]["table"]>

  const validate = Effect.gen(function* () {
    yield* Effect.reduce(tables, HashSet.empty<string>, Effect.fn("Application.validateTable")(function* (names, table) {
      if (HashSet.has(names, table.name)) {
        return yield* ApplicationDefinitionError.make({ reason: `Duplicate resource table ${table.name}` })
      }

      return HashSet.add(names, table.name)
    }))

    const proceduresForGroup = (group: AnyCommandBundle["group"]) => pipe(group.requests.values(), Array.fromIterable)
    const procedures = Array.flatMap(groups, proceduresForGroup)

    yield* Effect.reduce(procedures, HashSet.empty<string>, Effect.fn("Application.validateOperation")(function* (names, procedure) {
      if (HashSet.has(names, procedure._tag)) {
        return yield* ApplicationDefinitionError.make({ reason: `Duplicate operation ${procedure._tag}` })
      }

      if (RpcSchema.isStreamSchema(procedure.successSchema)) {
        return yield* ApplicationDefinitionError.make({ reason: `Application commands must be unary: ${procedure._tag}` })
      }

      return HashSet.add(names, procedure._tag)
    }))
  })

  pipe(validate, Effect.runSync)
  const group = RpcGroup.make().merge(...groups) as ApplicationGroup<Resources, Commands>
  const layers = Array.map(bundles, Struct.get("handlers")) as Array<HandlerLayer<Resources[number] | Commands[number]>>
  const handlers = Layer.mergeAll(Layer.empty, ...layers)

  return Struct.assign(options, { resources, commands, group, tables, handlers })
}

export interface Application extends AnyCommandBundle {
  readonly name: string
  readonly resources: ReadonlyArray<Resource>
  readonly tables: ReadonlyArray<Table>
}

export const Application = {
  make,
  prepare: Effect.fn("Application.prepare")(function* (application: Application) {
    const snapshots = Array.map(application.tables, Table.snapshot)
    const store = yield* SchemaStore
    yield* store.prepare(snapshots)
  }),
}
