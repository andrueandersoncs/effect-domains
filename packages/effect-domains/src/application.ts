import { Array, Context, Effect, Function, HashSet, Layer, Match, Option, Schema, Struct, pipe } from "effect"
import { RpcGroup, RpcSchema } from "effect/unstable/rpc"
import type { RpcBundle } from "./rpc-contract.ts"
import { SchemaStore } from "./migrations.ts"
import type { Resource } from "./resource.ts"
import { Table } from "./table.ts"
import { OperationDependencies } from "./operation.ts"

type HandlerLayer<Bundle> = Bundle extends {
  readonly handlers: infer Handlers extends Layer.Layer<never, any, any>
} ? Handlers : never

type PartResources<Part> = Part extends Resource ? Part
  : Part extends { readonly resources: ReadonlyArray<infer R extends Resource> } ? R
  : never

const isApplication = (part: RpcBundle): part is Application => "resources" in part
const isResource = (part: RpcBundle): part is Resource => "table" in part && "contracts" in part
const noResources = Function.constant<ReadonlyArray<Resource>>([])

const resourcesFrom = (part: RpcBundle) => pipe(
  Match.value(part),
  Match.when(isApplication, Struct.get<Application, "resources">("resources")),
  Match.when(isResource, Array.of),
  Match.orElse(noResources),
)

class ApplicationDefinitionError extends Schema.TaggedError<ApplicationDefinitionError>()(
  "ApplicationDefinitionError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

const emptyParts = [] as const

const make = <const Parts extends ReadonlyArray<RpcBundle> = typeof emptyParts>(
  options: Readonly<{ name: string }> & Readonly<Partial<{ parts: Parts }>>,
) => {
  const parts: ReadonlyArray<Parts[number]> = options.parts ?? emptyParts
  const resources = Array.flatMap(parts, resourcesFrom) as Array<PartResources<Parts[number]>>
  const groups = Array.map(parts, Struct.get("group"))
  const tables = Array.map(resources, Struct.get("table"))

  const validate = Effect.gen(function* () {
    yield* Effect.reduce(tables, HashSet.empty<string>, Effect.fn("Application.validateTable")(function* (names, table) {
      if (HashSet.has(names, table.name)) {
        return yield* ApplicationDefinitionError.make({ reason: `Duplicate resource table ${table.name}` })
      }

      return HashSet.add(names, table.name)
    }))

    yield* Effect.forEach(tables, Effect.fn("Application.validateRelationTargets")(function* (table) {
      yield* Effect.forEach(table.relationTargets, Effect.fn("Application.validateRelationTarget")(function* (target) {
        if (!Array.contains(tables, target)) {
          return yield* ApplicationDefinitionError.make({
            reason: `Resource table ${table.name} references unregistered table ${target.name}; use the registered resource's table`,
          })
        }
      }))
    }))

    const snapshots = Array.map(tables, Table.snapshot)
    yield* Table.validateRelations(snapshots)

    const proceduresForGroup = (group: RpcBundle["group"]) => pipe(group.requests.values(), Array.fromIterable)
    const procedures = Array.flatMap(groups, proceduresForGroup)

    yield* Effect.forEach(procedures, Effect.fn("Application.validateOperationDependencies")(function* (procedure) {
      const dependencies = pipe(
        Context.getOption(procedure.annotations, OperationDependencies),
        Option.map(Struct.get("tables")),
        Option.getOrElse(() => []),
      )

      yield* Effect.forEach(dependencies, Effect.fn("Application.validateOperationTable")(function* (dependency) {
        if (!Array.contains(tables, dependency)) {
          return yield* ApplicationDefinitionError.make({
            reason: `Operation ${procedure._tag} reads unregistered table ${dependency.name}; use the registered resource's table`,
          })
        }
      }))
    }))

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
  const group = RpcGroup.make().merge(...groups) as RpcGroup.RpcGroup<RpcGroup.Rpcs<Parts[number]["group"]>>
  const layers = Array.map(parts, Struct.get("handlers")) as Array<HandlerLayer<Parts[number]>>
  const handlers = Layer.mergeAll(Layer.empty, ...layers)

  return Struct.assign(options, { resources, tables, group, handlers })
}

export interface Application extends RpcBundle {
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
