import { Array, Effect, Function, HashSet, Layer, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc"
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

const make = <
  const Resources extends ReadonlyArray<Resource>,
  const Commands extends ReadonlyArray<AnyCommandBundle>,
>(options: Readonly<{
  name: string
  resources: Resources
  commands: Commands
}>) => {
  const { resources, commands } = options
  const bundles = [...resources, ...commands]
  const groups = Array.map(bundles, Struct.get("group"))
  const tables = Array.map(resources, Struct.get("table")) as Array<Resources[number]["table"]>
  const tableNames = HashSet.empty<string>()
  const operationNames = HashSet.empty<string>()

  const validateTable = (names: HashSet.HashSet<string>, table: Table) =>
    HashSet.has(names, table.name)
      ? ApplicationDefinitionError.make({ reason: `Duplicate resource table ${table.name}` })
      : pipe(names, HashSet.add(table.name), Effect.succeed)

  const validateProcedure = (names: HashSet.HashSet<string>, procedure: Rpc.AnyWithProps) => {
    if (HashSet.has(names, procedure._tag)) {
      return ApplicationDefinitionError.make({ reason: `Duplicate operation ${procedure._tag}` })
    }

    return RpcSchema.isStreamSchema(procedure.successSchema)
      ? ApplicationDefinitionError.make({ reason: `Application commands must be unary: ${procedure._tag}` })
      : pipe(names, HashSet.add(procedure._tag), Effect.succeed)
  }

  const procedures = Array.flatMap(groups, (group) => [...group.requests.values()])

  const validate = Effect.gen(function* () {
    yield* Effect.reduce(tables, Function.constant(tableNames), validateTable)
    yield* Effect.reduce(procedures, Function.constant(operationNames), validateProcedure)
  })

  Effect.runSync(validate)
  const group = RpcGroup.make().merge(...groups) as ApplicationGroup<Resources, Commands>
  const layers = Array.map(bundles, Struct.get("handlers")) as Array<HandlerLayer<Resources[number] | Commands[number]>>
  const handlers = Layer.mergeAll(Layer.empty, ...layers)

  return Struct.assign(options, { group, tables, handlers })
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
