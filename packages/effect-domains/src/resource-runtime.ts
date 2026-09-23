import { Array, Data, Effect, Equivalence, Function, type Layer, Option, Predicate, Record, Ref, Struct, pipe } from "effect"
import type { RepositoryStore } from "./repository-store.ts"
import { Table } from "./table.ts"
import type { StructSchema } from "./domain.ts"
import type { TransitionMachine } from "./transitions.ts"
import { compileResourceValue } from "./resource-compiler.ts"
import type { Resource } from "./resource-model.ts"
import { type CompleteResourceOperations, type DeclaredResourceOperations, type DefinitionStorage, type DefinitionTransition, type DefinitionVersion, operationEntry, type ResourceReference, type ResourceSpec } from "./resource-definition.ts"

type ResourceRequirements<S extends StructSchema, Storage extends StructSchema> =
  | RepositoryStore
  | S["DecodingServices"]
  | S["EncodingServices"]
  | Storage["DecodingServices"]
  | Storage["EncodingServices"]

type ExactResourceRuntime<
  Runtime extends { readonly handlers: Layer.Any },
  S extends StructSchema,
  Storage extends StructSchema,
> = Omit<Runtime, "handlers"> & Readonly<{
  handlers: Layer.Layer<
    Layer.Success<Runtime["handlers"]>,
    Layer.Error<Runtime["handlers"]>,
    ResourceRequirements<S, Storage>
  >
}>

export type ResourceRuntime<Spec extends ResourceSpec> =
  string extends Spec["name"] ? Resource : ExactResourceRuntime<
    ReturnType<typeof compileResourceValue<
      Spec["name"],
      Spec["schema"],
      DefinitionStorage<Spec>,
      Spec["authorization"],
      DeclaredResourceOperations<Spec["capabilities"]>,
      Extract<
        DefinitionVersion<Spec>,
        Extract<keyof Spec["schema"]["fields"], string> | undefined
      >,
      DefinitionTransition<Spec>
    >>,
    Spec["schema"],
    DefinitionStorage<Spec>
  >

class CompiledResourceCacheEntry extends Data.Class<{
  readonly spec: ResourceSpec
  readonly resource: Resource
}> {}

const emptyCompiledResources: ReadonlyArray<CompiledResourceCacheEntry> = []
const compiledResources = pipe(emptyCompiledResources, Ref.make, Effect.runSync)
const sameResourceSpec = Equivalence.strictEqual<ResourceSpec>()

// SAFETY: The runtime has the requested spec because compilation derives every runtime product from that exact spec.
const resourceRuntimeFor = <Spec extends ResourceSpec>(resource: Resource) =>
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  resource as ResourceRuntime<Spec>

function getOrCompileResourceFromSpec<const Spec extends ResourceSpec>(
  spec: Spec,
): ResourceRuntime<Spec> {

  const matchesSpec = (entry: CompiledResourceCacheEntry) => sameResourceSpec(entry.spec, spec)
  const resources = pipe(Ref.get(compiledResources), Effect.runSync)
  const cached = Array.findFirst(resources, matchesSpec)

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  if (Option.isSome(cached)) return cached.value.resource as ResourceRuntime<Spec>

  const operationEntries = Array.map(spec.capabilities, operationEntry)

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const operations = Record.fromEntries(operationEntries) as
    DeclaredResourceOperations<Spec["capabilities"]>

  const declaredRelations = Option.fromNullishOr(spec.relations)

  const relations = Option.match(declaredRelations, {
    onNone: Function.constant(undefined),
    onSome: (relations) => {
      if (relations.foreignKeys == null) return relations

      const compileForeignKey = ({ references, ...foreignKey }: typeof relations.foreignKeys[number]) => {
        const isResourceReference = (
          reference: typeof references,
        ): reference is ResourceReference => Predicate.hasProperty(reference, "resource")

        if (!isResourceReference(references)) {
          return Struct.assign(foreignKey, { references })
        }

        const target = getOrCompileResourceFromSpec(references.resource)

        const reference = Table.reference(
          target.table,
          // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
          references.fields as ReadonlyArray<string>,
        )

        return Struct.assign(foreignKey, { references: reference })
      }

      const foreignKeys = Array.map(relations.foreignKeys, compileForeignKey)

      return Struct.assign(relations, { foreignKeys })
    },
  })

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const compiled = compileResourceValue({
    authorization: spec.authorization,
    name: spec.name,
    operations,
    relations,
    schema: spec.schema,
    storage: spec.storage,
    transitions: spec.transitions,
    version: spec.version,
  } as never)

  const cacheEntry = new CompiledResourceCacheEntry({ spec, resource: compiled })

  const cacheResource = (resources: ReadonlyArray<CompiledResourceCacheEntry>) =>
    Array.append(resources, cacheEntry)

  pipe(
    Ref.update(compiledResources, cacheResource),
    Effect.runSync,
  )

  return resourceRuntimeFor<Spec>(compiled)
}

type ExactRepository<
  Repository,
  S extends StructSchema,
  Storage extends StructSchema,
> = {
  readonly [Key in keyof Repository]:
    Repository[Key] extends (...arguments_: infer Arguments) => Effect.Effect<
      infer Success,
      infer Failure,
      unknown
    >
      ? (...arguments_: Arguments) => Effect.Effect<
        Success,
        Failure,
        ResourceRequirements<S, Storage>
      >
      : Repository[Key]
}

type RepositoryFor<Spec extends ResourceSpec> =
  string extends Spec["name"] ? ReturnType<typeof compileResourceValue>["repository"] : ExactRepository<
    Extract<
      ReturnType<typeof compileResourceValue<
        Spec["name"],
        Spec["schema"],
        DefinitionStorage<Spec>,
        Spec["authorization"],
        CompleteResourceOperations<
          Spec["schema"],
          Spec["authorization"],
          Spec["capabilities"]
        >,
        Extract<
          DefinitionVersion<Spec>,
          Extract<keyof Spec["schema"]["fields"], string> | undefined
        >,
        TransitionMachine | undefined
      >>,
      { readonly repository: unknown }
    >["repository"],
    Spec["schema"],
    DefinitionStorage<Spec>
  >

export type ResourceTable<Spec extends ResourceSpec> =
  string extends Spec["name"] ? Table
    : ResourceRuntime<Spec> extends { readonly table: infer ResourceTable extends Table }
      ? ResourceTable
      : Table

const valueFromSpec = <const Spec extends ResourceSpec>(spec: Spec): ResourceRuntime<Spec> =>
  getOrCompileResourceFromSpec(spec)

const repository = <const Spec extends ResourceSpec>(spec: Spec) => {
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const runtime = getOrCompileResourceFromSpec(spec) as { readonly repository: RepositoryFor<Spec> }
  return Struct.assign(runtime.repository, {
    find: runtime.repository.find,
    ensure: runtime.repository.ensure,
  })
}

const table = <const Spec extends ResourceSpec>(spec: Spec) => {
  const runtime = getOrCompileResourceFromSpec(spec)

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  return runtime.table as ResourceTable<Spec>
}

const reference = <
  const Target extends ResourceSpec,
  const Fields extends ReadonlyArray<
    Extract<keyof ResourceTable<Target>["rowSchema"]["fields"], string>
  >,
>(
  resource: Target,
  fields: Fields,
): ResourceReference<Target> => {
  const frozenFields = Object.freeze([...fields])

  return Object.freeze({
    resource,
    fields: frozenFields,
  })
}

export {
  getOrCompileResourceFromSpec,
  reference,
  repository,
  table,
  valueFromSpec,
}
