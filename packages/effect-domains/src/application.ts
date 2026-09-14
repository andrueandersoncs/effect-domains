import { Array, Effect, HashSet, Layer, Match, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc"
import { Command, type AnyCommandBundle, type CommandLive } from "./command.ts"
import { SchemaStore } from "./migrations.ts"
import { Resource, type AnyResourceSpec, type Resource as CompiledResource, type ResourceRuntime } from "./resource.ts"
import { type RpcBundle, type RpcProcedure } from "./rpc-contract.ts"
import { Table } from "./table.ts"

type ApplicationPart =
  | Readonly<{ readonly _tag: "ResourcePart"; readonly resource: AnyResourceSpec }>
  | Readonly<{ readonly _tag: "CommandPart"; readonly bundle: AnyCommandBundle }>
  | Readonly<{ readonly _tag: "NativePart"; readonly bundle: RpcBundle }>
  | Readonly<{ readonly _tag: "ApplicationPart"; readonly application: ApplicationSpec }>

export interface ApplicationSpec<
  Parts extends ReadonlyArray<ApplicationPart> = ReadonlyArray<ApplicationPart>,
> {
  readonly _tag: "ApplicationSpec"
  readonly name: string
  readonly parts: Parts
}

const resourcePart = <const Spec extends AnyResourceSpec>(
  resource: Spec,
) => Object.freeze({ _tag: "ResourcePart" as const, resource })

const commandPart = <const Bundle extends AnyCommandBundle>(
  bundle: Bundle,
) => Object.freeze({ _tag: "CommandPart" as const, bundle })

const nativePart = <const Bundle extends RpcBundle>(
  bundle: Bundle,
) => Object.freeze({ _tag: "NativePart" as const, bundle })

const applicationPart = <const Spec extends ApplicationSpec>(
  application: Spec,
) => Object.freeze({ _tag: "ApplicationPart" as const, application })

const define = <const Parts extends ReadonlyArray<ApplicationPart>>(
  definition: Readonly<{ name: string; parts: Parts }>,
): ApplicationSpec<Parts> => Object.freeze({
  _tag: "ApplicationSpec" as const,
  name: definition.name,
  parts: Object.freeze([...definition.parts]) as Parts,
})

class ApplicationDefinitionError extends Schema.TaggedError<ApplicationDefinitionError>()(
  "ApplicationDefinitionError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

interface CompiledPart {
  readonly bundle: RpcBundle
  readonly resources: ReadonlyArray<CompiledResource>
  readonly commands: ReadonlyArray<CommandLive>
}

const noResources: ReadonlyArray<CompiledResource> = Object.freeze([])
const noCommands: ReadonlyArray<CommandLive> = Object.freeze([])

type ApplicationDepth = 0 | 1 | 2 | 3 | 4 | 5
type PreviousDepth = { readonly 0: 0; readonly 1: 0; readonly 2: 1; readonly 3: 2; readonly 4: 3; readonly 5: 4 }

type PartBundle<Part, Depth extends ApplicationDepth = 5> =
  Part extends { readonly _tag: "ResourcePart"; readonly resource: infer Spec extends AnyResourceSpec }
    ? ResourceRuntime<Spec>
    : Part extends { readonly _tag: "CommandPart"; readonly bundle: infer Bundle extends AnyCommandBundle }
      ? Bundle
      : Part extends { readonly _tag: "NativePart"; readonly bundle: infer Bundle extends RpcBundle }
        ? Bundle
        : Part extends { readonly _tag: "ApplicationPart"; readonly application: infer Spec extends ApplicationSpec }
          ? Depth extends 0 ? RpcBundle : ApplicationIRFor<Spec, PreviousDepth[Depth]>
          : never

type BundleRpcs<Bundle> =
  Bundle extends { readonly group: RpcGroup.RpcGroup<infer Rpcs extends RpcProcedure> } ? Rpcs : never

type BundleHandlers<Bundle> =
  Bundle extends { readonly handlers: infer Handlers extends Layer.Any } ? Handlers : never

type BundleError<Bundle> = Layer.Error<BundleHandlers<Bundle>>

type BundleRequirements<Bundle> = Layer.Services<BundleHandlers<Bundle>>

type PartUnion<Spec extends ApplicationSpec> = Spec["parts"][number]

export type ApplicationIRFor<
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
  readonly _tag: "ApplicationIR"
  readonly definition: ApplicationSpec
  readonly name: string
  readonly resources: ReadonlyArray<CompiledResource>
  readonly commands: ReadonlyArray<CommandLive>
  readonly tables: ReadonlyArray<Table>
}


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
      if (!Array.contains(tables, target)) {
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
      if (!Array.contains(tables, dependency)) {
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

const compileApplication = (definition: ApplicationSpec): ApplicationIR => {
  const compilePart = (part: ApplicationPart): CompiledPart => pipe(
    Match.value(part),
    Match.tagsExhaustive({
      ResourcePart: ({ resource }) => {
        const compiled = Resource.compile(resource)
        return { bundle: compiled, resources: [compiled], commands: noCommands }
      },
      CommandPart: ({ bundle }) => ({
        bundle,
        resources: noResources,
        commands: bundle.commands,
      }),
      NativePart: ({ bundle }) => ({
        bundle,
        resources: noResources,
        commands: noCommands,
      }),
      ApplicationPart: ({ application }) => {
        const compiled = compileApplication(application)
        return {
          bundle: compiled,
          resources: compiled.resources,
          commands: compiled.commands,
        }
      },
    }),
  )

  const parts = Array.map(definition.parts, compilePart)
  const bundles = Array.map(parts, Struct.get("bundle"))
  const resources = Array.flatMap(parts, Struct.get("resources"))
  const commands = Array.flatMap(parts, Struct.get("commands"))
  const groups = Array.map(bundles, Struct.get("group"))
  const validation = Effect.runSync(validateApplication(resources, groups, commands))
  const group = RpcGroup.make().merge(...groups)
  const layers = Array.map(bundles, Struct.get("handlers"))
  const handlers = Layer.mergeAll(Layer.empty, ...layers)

  return Object.freeze({
    _tag: "ApplicationIR" as const,
    definition,
    name: definition.name,
    resources,
    commands,
    tables: validation.tables,
    group,
    handlers,
  }) as unknown as ApplicationIR
}
const compile = <const Definition extends ApplicationSpec>(
  definition: Definition,
): ApplicationIRFor<Definition> =>
  compileApplication(definition) as unknown as ApplicationIRFor<Definition>

const prepare = Effect.fn("Application.prepare")(function* (
  application: ApplicationIR,
) {
  const snapshots = Array.map(application.tables, Table.snapshot)
  const store = yield* SchemaStore
  yield* store.prepare(snapshots)
})

export const Part = {
  resource: resourcePart,
  command: commandPart,
  native: nativePart,
  application: applicationPart,
}

export const Application = { define, compile, prepare }
