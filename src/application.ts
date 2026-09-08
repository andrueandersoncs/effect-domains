import { Array, Effect, HashSet, Layer, Record, Schema, type Scope, Struct, pipe } from "effect"
import { Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc"
import { SchemaStore } from "./migrations.ts"
import type { Resource } from "./resource.ts"
import { Table } from "./table.ts"

export type CommandContract = Readonly<{
  input: Schema.Top
  output: Schema.Top
  error: Schema.Top
}>

export type CommandContracts = Readonly<Record<string, CommandContract>>

export type CommandService<Contracts extends CommandContracts> = {
  readonly [Name in keyof Contracts]: (
    input: Contracts[Name]["input"]["Type"],
  ) => Effect.Effect<
    Contracts[Name]["output"]["Type"],
    Contracts[Name]["error"]["Type"],
    never
  >
}

type CommandRpc<Name extends string, Contract extends CommandContract> = Rpc.Rpc<
  Name,
  Schema.toCodecJson<Contract["input"]>,
  Schema.toCodecJson<Contract["output"]>,
  Schema.toCodecJson<Contract["error"]>
>

type CommandRpcs<Contracts extends CommandContracts> = {
  readonly [Name in keyof Contracts & string]: CommandRpc<Name, Contracts[Name]>
}[keyof Contracts & string]

type ResourceRpcs<Resources extends ReadonlyArray<Resource>> =
  Resources[number] extends { readonly group: infer Group }
    ? RpcGroup.Rpcs<Group>
    : never

type ApplicationGroup<
  Resources extends ReadonlyArray<Resource>,
  Commands extends CommandContracts,
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
  toLayer: Schema.Any,
}) {
  static override make<
    const Resources extends ReadonlyArray<Resource>,
    const Commands extends CommandContracts = {},
  >(
    options: Readonly<{ name: string; resources: Resources }> | Readonly<{
      name: string
      resources: Resources
      commands: Commands
    }>,
  ) {
    const commands = "commands" in options ? options.commands : ({} as Commands)
    const commandEntries = Record.toEntries(commands)

    const commandProcedures = Array.map(commandEntries, ([name, command]) => {
      const payloadSchema = Schema.toCodecJson(command.input)
      const successSchema = Schema.toCodecJson(command.output)
      const errorSchema = Schema.toCodecJson(command.error)
      return Rpc.make(name, { payload: payloadSchema, success: successSchema, error: errorSchema })
    }) as Array<CommandRpcs<Commands>>

    const commandGroup = RpcGroup.make(...commandProcedures)
    const resourceGroups = Array.map(options.resources, Struct.get("group"))

    const groups: ReadonlyArray<Pick<RpcGroup.RpcGroup<Rpc.Any>, "requests">> = Array.prepend(
      resourceGroups,
      commandGroup,
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

    const group = commandGroup.merge(...resourceGroups) as ApplicationGroup<
      Resources,
      Commands
    >

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

    const toLayer = <
      Implementation extends CommandService<Commands>,
      EX = never,
      RX = never,
    >(
      implementation: Implementation | Effect.Effect<Implementation, EX, RX>,
    ) => {
      // Only service construction needs RX because domain handlers capture their dependencies.
      const implementationLayer = commandGroup.toLayer(
        implementation as
          | RpcGroup.HandlersFrom<CommandRpcs<Commands>>
          | Effect.Effect<RpcGroup.HandlersFrom<CommandRpcs<Commands>>, EX, RX>,
      ) as Layer.Layer<Rpc.ToHandler<CommandRpcs<Commands>>, EX, Exclude<RX, Scope.Scope>>

      return Layer.provideMerge(implementationLayer, handlers)
    }

    return super.make({
      name: options.name,
      resources: options.resources,
      commands,
      group,
      tables,
      handlers,
      prepare,
      toLayer,
    }) as Struct.Assign<Application, {
      name: string
      resources: Resources
      commands: Commands
      group: ApplicationGroup<Resources, Commands>
      tables: Array<Resources[number]["table"]>
      handlers: typeof handlers
      prepare: typeof prepare
      toLayer: typeof toLayer
    }>
  }
}
