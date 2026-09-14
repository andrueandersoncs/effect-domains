import { Array, Data, Effect, Equivalence, HashSet, Layer, Match, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc"
import { Command, type AnyCommandBundle, type CommandLive } from "./command.ts"
import { SchemaStore } from "./migrations.ts"
import { Resource, type ResourceSpec, type Resource as CompiledResource, type ResourceRuntime } from "./resource.ts"
import { RpcBundle, type RpcProcedure } from "./rpc-contract.ts"
import { Table } from "./table.ts"


type ApplicationPart = Data.TaggedEnum<{
  ResourcePart: { readonly resource: ResourceSpec }
  CommandPart: { readonly bundle: AnyCommandBundle }
  NativePart: { readonly bundle: RpcBundle }
  ApplicationPart: { readonly application: ApplicationSpec }
}>

class ApplicationSpec<
  Parts extends ReadonlyArray<ApplicationPart> = ReadonlyArray<ApplicationPart>,
> extends Data.Class<{
  readonly name: string
  readonly parts: Parts
}> {}

const ApplicationParts = Data.taggedEnum<ApplicationPart>()

const resourcePart = <const Spec extends ResourceSpec>(resource: Spec) => {
  const part = ApplicationParts.ResourcePart({ resource })
  return Struct.assign(part, { resource })
}

const commandPart = <const Bundle extends AnyCommandBundle>(bundle: Bundle) => {
  const part = ApplicationParts.CommandPart({ bundle })
  return Struct.assign(part, { bundle })
}

const nativePart = <const Bundle extends RpcBundle>(bundle: Bundle) => {
  const part = ApplicationParts.NativePart({ bundle })
  return Struct.assign(part, { bundle })
}

const applicationPart = <const Spec extends ApplicationSpec>(application: Spec) => {
  const part = ApplicationParts.ApplicationPart({ application })
  return Struct.assign(part, { application })
}

const define = <const Parts extends ReadonlyArray<ApplicationPart>>(
  definition: Readonly<{ name: string; parts: Parts }>,
): ApplicationSpec<Parts> => {
  const parts = Object.freeze([...definition.parts]) as Parts
  return new ApplicationSpec({ name: definition.name, parts })
}

class ApplicationDefinitionError extends Schema.TaggedError<ApplicationDefinitionError>()(
  "ApplicationDefinitionError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

class CompiledPart extends Data.Class<{
  readonly bundle: RpcBundle
  readonly resources: ReadonlyArray<CompiledResource>
  readonly commands: ReadonlyArray<CommandLive>
}> {}

const noResources: ReadonlyArray<CompiledResource> = Object.freeze([])
const noCommands: ReadonlyArray<CommandLive> = Object.freeze([])

type ApplicationDepth = 0 | 1 | 2 | 3 | 4 | 5

type PreviousDepth<Depth extends ApplicationDepth> =
  Depth extends 5 ? 4
    : Depth extends 4 ? 3
      : Depth extends 3 ? 2
        : Depth extends 2 ? 1
          : 0

type PartBundle<Part, Depth extends ApplicationDepth = 5> =
  Part extends { readonly _tag: "ResourcePart"; readonly resource: infer Spec extends ResourceSpec }
    ? ResourceRuntime<Spec>
    : Part extends { readonly _tag: "CommandPart"; readonly bundle: infer Bundle extends AnyCommandBundle }
      ? Bundle
      : Part extends { readonly _tag: "NativePart"; readonly bundle: infer Bundle extends RpcBundle }
        ? Bundle
        : Part extends { readonly _tag: "ApplicationPart"; readonly application: infer Spec extends ApplicationSpec }
          ? Depth extends 0 ? RpcBundle : ApplicationIRFor<Spec, PreviousDepth<Depth>>
          : never

type BundleRpcs<Bundle> =
  Bundle extends { readonly group: RpcGroup.RpcGroup<infer Rpcs extends RpcProcedure> } ? Rpcs : never

type BundleHandlers<Bundle> =
  Bundle extends { readonly handlers: infer Handlers extends Layer.Any } ? Handlers : never

type BundleError<Bundle> = Layer.Error<BundleHandlers<Bundle>>

type BundleRequirements<Bundle> = Layer.Services<BundleHandlers<Bundle>>

type PartUnion<Spec extends ApplicationSpec> = Spec["parts"][number]

type ApplicationIRFor<
  Spec extends ApplicationSpec,
  Depth extends ApplicationDepth = 5,
> = Omit<ApplicationIR, "group" | "handlers"> & Readonly<{
  group: RpcGroup.RpcGroup<
    BundleRpcs<PartBundle<PartUnion<Spec>, Depth>>
  >
  handlers: Layer.Layer<
    Rpc.ToHandler<BundleRpcs<PartBundle<PartUnion<Spec>, Depth>>>,
    BundleError<PartBundle<PartUnion<Spec>, Depth>>,
    BundleRequirements<PartBundle<PartUnion<Spec>, Depth>>
  >
}>

export interface ApplicationIR extends RpcBundle {
  readonly name: string
  readonly resources: ReadonlyArray<CompiledResource>
  readonly commands: ReadonlyArray<CommandLive>
  readonly tables: ReadonlyArray<Table>
}


const containsTable = Array.containsWith(Equivalence.strictEqual<Table>())


const validateApplication = Effect.fn("Application.validate")(function* (
  resources: ReadonlyArray<CompiledResource>,
  groups: ReadonlyArray<RpcBundle["group"]>,
  commands: ReadonlyArray<CommandLive>,
) {
  const tables = Array.map(resources, Struct.get("table"))

  yield* Effect.reduce(tables, HashSet.empty<string>, Effect.fn("Application.validateTable")(function* (names, table) {
    if (HashSet.has(names, table.name)) {
      return yield* ApplicationDefinitionError.make({ reason: `Duplicate resource table ${table.name}` })
    }

    return HashSet.add(names, table.name)
  }))

  yield* Effect.forEach(tables, Effect.fn("Application.validateRelationTargets")(function* (table) {
    yield* Effect.forEach(table.relationTargets, Effect.fn("Application.validateRelationTarget")(function* (target) {
      if (!containsTable(tables, target)) {
        return yield* ApplicationDefinitionError.make({
          reason: `Resource table ${table.name} references unregistered table ${target.name}; use the registered resource's table`,
        })
      }
    }))
  }))

  const snapshots = Array.map(tables, Table.snapshot)
  yield* Table.validateRelations(snapshots)

  const proceduresForGroup = (group: RpcBundle["group"]) =>
    pipe(group.requests.values(), Array.fromIterable)

  const procedures = Array.flatMap(groups, proceduresForGroup)

  yield* Effect.forEach(commands, Effect.fn("Application.validateCommandDependencies")(function* (command) {
    const dependencies = Command.dependencies(command.spec.dependencies ?? [])

    yield* Effect.forEach(dependencies.tables, Effect.fn("Application.validateCommandTable")(function* (dependency) {
      if (!containsTable(tables, dependency)) {
        return yield* ApplicationDefinitionError.make({
          reason: `Command ${command.spec.name} reads unregistered table ${dependency.name}; use the registered resource definition`,
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

  return { tables, procedures }
})

const compileParts = (
  parts: ReadonlyArray<ApplicationPart>,
): ReadonlyArray<CompiledPart> => {
  const compileNestedParts = (part: ApplicationPart): ReadonlyArray<CompiledPart> => pipe(
    Match.value(part),
    Match.tagsExhaustive({
      ResourcePart: ({ resource }) => {
        const compiled = Resource.compile(resource)
        return [new CompiledPart({ bundle: compiled, resources: [compiled], commands: noCommands })]
      },
      CommandPart: ({ bundle }) => [
        new CompiledPart({ bundle, resources: noResources, commands: bundle.commands }),
      ],
      NativePart: ({ bundle }) => [
        new CompiledPart({ bundle, resources: noResources, commands: noCommands }),
      ],
      ApplicationPart: ({ application }) => compileParts(application.parts),
    }),
  )

  return Array.flatMap(parts, compileNestedParts)
}

function compileApplication<const Definition extends ApplicationSpec>(
  definition: Definition,
): ApplicationIRFor<Definition>

function compileApplication(definition: ApplicationSpec): ApplicationIR


function compileApplication(definition: ApplicationSpec): ApplicationIR {
  const parts = compileParts(definition.parts)
  const bundles = Array.map(parts, Struct.get("bundle"))
  const resources = Array.flatMap(parts, Struct.get("resources"))
  const commands = Array.flatMap(parts, Struct.get("commands"))
  const groups = Array.map(bundles, Struct.get("group"))
  const validationEffect = validateApplication(resources, groups, commands)
  const validation = Effect.runSync(validationEffect)
  const group = RpcGroup.make().merge(...groups)
  const layers = Array.map(bundles, Struct.get("handlers"))
  const handlers = Layer.mergeAll(Layer.empty, ...layers)
  const bundle = RpcBundle.make(group)(handlers)

  return Struct.assign(bundle, {
    name: definition.name,
    resources,
    commands,
    tables: validation.tables,
  })

}

const prepareApplication = function* (
  application: ApplicationIR,
) {
  const snapshots = Array.map(application.tables, Table.snapshot)
  const store = yield* SchemaStore
  yield* store.prepare(snapshots)
}

export const Part = {
  resource: resourcePart,
  command: commandPart,
  native: nativePart,
  application: applicationPart,
}

export const Application = {
  define,
  compile: compileApplication,
  prepare: Effect.fn("Application.prepare")(prepareApplication),
}
