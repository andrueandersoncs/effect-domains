import { Array, Data, Effect, Equivalence, flow, Function, Layer, Option, Predicate, Record, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { VersionConflict } from "./repository-store.ts"
import { Table } from "./table.ts"
import type { StructSchema, StructValue } from "./domain.ts"
import { Page } from "./page.ts"
import type { AuthorizationDefinition, PolicyAuthorization } from "./authorization-model.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import type { TransitionMachine } from "./transitions.ts"
import { type CreationFrom, type ExpectedVersion, ForbiddenFieldSchema, type ListFrom, type ListPolicy, type PublishedOperation, PublicResourceErrorSchema, type ResourceChanges, ResourceErrorSchema, type ResourceListRequest, type ResourceOperation, type ResourceOperations, type ResourceDraft, type TransitionChanges } from "./resource-model.ts"
import { prepareResource, type ResourceCompilerOptions } from "./resource-compiler-prepare.ts"

// SAFETY: Resource preparation keeps these intersections tied to the same schema because each value shares one declaration.
const narrowContract = <Target, Source>(value: Source) => value as Source & Target

type ResourceRepository<Key, Row, Changes, TransitionChange, Version extends string | undefined> = Readonly<{
  get: (key: Key) => Effect.Effect<Row, unknown, unknown>
  list: (...arguments_: ReadonlyArray<never>) => Effect.Effect<unknown, unknown, unknown>
  create: (...arguments_: ReadonlyArray<never>) => Effect.Effect<unknown, unknown, unknown>
  update: (...arguments_: ReadonlyArray<never>) => Effect.Effect<unknown, unknown, unknown>
  patch: (key: Key, changes: Changes, ...versions: [...ExpectedVersion<Version>]) => Effect.Effect<Row, unknown, unknown>
  remove: (key: Key) => Effect.Effect<void, unknown, unknown>
  transition: (key: Key, action: string, changes: TransitionChange, ...versions: [...ExpectedVersion<Version>]) => Effect.Effect<Row, unknown, unknown>
}>

export const makeResourceContractSchemas = <
  const Name extends string,
  const S extends StructSchema,
  const Storage extends StructSchema = S,
  const Auth extends AuthorizationDefinition = AuthorizationDefinition,
  const Operations extends ResourceOperations<S, Auth> = ResourceOperations<S, Auth>,
  const Version extends Extract<keyof S["fields"], string> | undefined = undefined,
  const Transition extends TransitionMachine | undefined = undefined,
>(
  options: ResourceCompilerOptions<Name, S, Storage, Auth, Operations, Version, Transition>,
  context: Pick<ReturnType<typeof prepareResource<Name, S, Storage, Auth, Operations, Version, Transition>>,
    "canonicalIdentifierSchema" | "canonicalRowSchema" | "creationPlan" | "table" | "transitionOption" | "version" | "versionOption"
  > & Readonly<{
    listSchema: Schema.Top
  }>,
) => {

  const {
    canonicalIdentifierSchema,
    canonicalRowSchema,
    creationPlan,
    listSchema,
    table,
    transitionOption,
    version,
    versionOption,
  } = context

  const createInputAst = pipe(creationPlan.inputFields, Schema.Struct, Struct.get("ast"))

  const createInputSchema = Schema.make<Schema.Codec<
    ResourceDraft<S, CreationFrom<Operations>, Version>,
    unknown,
    S["DecodingServices"],
    S["EncodingServices"]
  >>(createInputAst)

  const IdentifierRequestStructSchema = Schema.Record(Schema.Literal(table.identifier), canonicalIdentifierSchema)

  const identifierRequestSchema = Schema.make<Schema.Codec<Readonly<Record<
    ReturnType<typeof Table.make<Name, S>>["identifier"],
    ReturnType<typeof Table.make<Name, S>>["identifierSchema"]["Type"]
  >>, unknown, S["DecodingServices"], S["EncodingServices"]>>(IdentifierRequestStructSchema.ast)

  const canonicalRowWireSchema = Schema.toCodecJson(canonicalRowSchema)
  const createWireSchema = Schema.toCodecJson(createInputSchema)
  const identifierWireSchema = Schema.toCodecJson(identifierRequestSchema)
  const PageSchema = Page.schema(canonicalRowWireSchema)

  const listInputSchema = Schema.make<Schema.Codec<
    ResourceListRequest<S, Extract<ListFrom<Operations>, ListPolicy<S>>>,
    unknown,
    S["DecodingServices"],
    S["EncodingServices"]
  >>(listSchema.ast)

  const listWireSchema = Schema.toCodecJson(listInputSchema)
  const canonicalMutableFields = Record.remove(options.schema.fields, table.identifier)
  const versionField = narrowContract<never, typeof version>(version)

  const mutableFields = Predicate.isUndefined(version)
    ? canonicalMutableFields
    : Record.remove(canonicalMutableFields, versionField)

  const optionalMutableFields = Record.map(mutableFields, Schema.optionalKey)
  const patchFields = Record.set(optionalMutableFields, table.identifier, ForbiddenFieldSchema)
  const patchFieldsAst = pipe(patchFields, Schema.Struct, Struct.get("ast"))
  const patchFieldsContract = Schema.make(patchFieldsAst)

  const PatchInputStructSchema = Predicate.isUndefined(version)
    ? Schema.Struct({ key: canonicalIdentifierSchema, changes: patchFieldsContract })
    : Schema.Struct({ key: canonicalIdentifierSchema, expectedVersion: Schema.Int, changes: patchFieldsContract })


  const patchInputSchema = Schema.make<Schema.Codec<Readonly<{
    key: ReturnType<typeof Table.make<Name, S>>["identifierSchema"]["Type"]
    changes: ResourceChanges<S, ReturnType<typeof Table.make<Name, S>>["identifier"], Version>
  }> & Readonly<Partial<{ expectedVersion: number }>>, unknown, S["DecodingServices"], S["EncodingServices"]>>(PatchInputStructSchema.ast)

  const patchWireSchema = Schema.toCodecJson(patchInputSchema)

  const transitionFieldsSchema = (field: string) => {
    const optionalFields = Record.map(mutableFields, Schema.optionalKey)
    const immutableIdentifier = Record.set(optionalFields, table.identifier, ForbiddenFieldSchema)
    const transitionFields = Record.set(immutableIdentifier, field, ForbiddenFieldSchema)

    return Schema.Struct(transitionFields)
  }

  const TransitionFieldsSchema = Option.match(transitionOption, {
    onNone: Function.constant(patchFieldsContract),
    onSome: (definition) => transitionFieldsSchema(definition.field),
  })

  const changesFieldSchema = Schema.optionalKey(TransitionFieldsSchema)

  const transitionInputStructSchema = Option.match(transitionOption, {
    onNone: () => Schema.Struct({ key: canonicalIdentifierSchema, action: Schema.String, changes: changesFieldSchema }),
    onSome: (definition) => Option.match(versionOption, {
      onNone: () => Schema.Struct({ key: canonicalIdentifierSchema, action: definition.actions, changes: changesFieldSchema }),
      onSome: () => Schema.Struct({ key: canonicalIdentifierSchema, action: definition.actions, expectedVersion: Schema.Int, changes: changesFieldSchema }),
    }),
  })

  const transitionJsonSchema = Schema.toCodecJson(transitionInputStructSchema)

  const transitionInputSchema = Schema.make<Schema.Codec<
    Readonly<{ key: ReturnType<typeof Table.make<Name, S>>["identifierSchema"]["Type"]; action: string }>
      & Readonly<Partial<{ changes: Partial<Omit<S["Type"], ReturnType<typeof Table.make<Name, S>>["identifier"] | Extract<Version, string> | Extract<Transition, { readonly field: string }>["field"]>> }>>
      & (Version extends string ? Readonly<{ expectedVersion: number }> : unknown),
    unknown,
    S["DecodingServices"],
    S["EncodingServices"]
  >>(transitionJsonSchema.ast)

  const isPublic = Equivalence.strictEqual()(options.authorization._tag, "Public")
  const resourceErrorsSchema = isPublic ? PublicResourceErrorSchema : ResourceErrorSchema
  const versionedErrorsSchema = Schema.Union([resourceErrorsSchema, VersionConflict])

  const selectedErrorSchema = Option.match(versionOption, {
    onNone: Function.constant(resourceErrorsSchema),
    onSome: Function.constant(versionedErrorsSchema),
  })

  const errorSchema = narrowContract<
    Auth extends { readonly _tag: "Public" } ? typeof PublicResourceErrorSchema : typeof ResourceErrorSchema,
    typeof selectedErrorSchema
  >(selectedErrorSchema)

  type TransitionError = Transition extends { readonly Error: infer Declared extends Schema.Top } ? Declared : typeof Schema.Never

  const declaredTransitionErrors = Option.map(transitionOption, Struct.get("Error"))
  const selectedTransitionErrorSchema = Option.getOrElse(declaredTransitionErrors, Function.constant(Schema.Never))

  const declaredTransitionErrorSchema = narrowContract<TransitionError, typeof selectedTransitionErrorSchema>(
    selectedTransitionErrorSchema,
  )

  const transitionErrorSchema = Schema.Union([errorSchema, declaredTransitionErrorSchema])

  return {
    createInputSchema,
    createWireSchema,
    identifierWireSchema,
    canonicalRowWireSchema,
    PageSchema,
    listWireSchema,
    patchInputSchema,
    patchWireSchema,
    transitionInputSchema,
    errorSchema,
    transitionErrorSchema,
  }
}

export const compileResourceContracts = <
  const Name extends string,
  const S extends StructSchema,
  const Storage extends StructSchema = S,
  const Auth extends AuthorizationDefinition = AuthorizationDefinition,
  const Operations extends ResourceOperations<S, Auth> = ResourceOperations<S, Auth>,
  const Version extends Extract<keyof S["fields"], string> | undefined = undefined,
  const Transition extends TransitionMachine | undefined = undefined,
  const Repository extends ResourceRepository<
    ReturnType<typeof Table.make<Name, S>>["identifierSchema"]["Type"],
    ReturnType<typeof Table.make<Name, S>>["rowSchema"]["Type"],
    ResourceChanges<S, ReturnType<typeof Table.make<Name, S>>["identifier"], Version>,
    TransitionChanges<S, ReturnType<typeof Table.make<Name, S>>["identifier"], Version, Transition>,
    Version
  > = ResourceRepository<
    ReturnType<typeof Table.make<Name, S>>["identifierSchema"]["Type"],
    ReturnType<typeof Table.make<Name, S>>["rowSchema"]["Type"],
    ResourceChanges<S, ReturnType<typeof Table.make<Name, S>>["identifier"], Version>,
    TransitionChanges<S, ReturnType<typeof Table.make<Name, S>>["identifier"], Version, Transition>,
    Version
  >,
>(
  options: ResourceCompilerOptions<Name, S, Storage, Auth, Operations, Version, Transition>,
  context: Pick<ReturnType<typeof prepareResource<Name, S, Storage, Auth, Operations, Version, Transition>>,
    "canonicalIdentifierSchema" | "canonicalRowSchema" | "creationPlan" | "operations" | "table" | "transitionOption" | "version" | "versionOption"
  > & Readonly<{
    listSchema: Schema.Top
    noTransitionChanges: TransitionChanges<S, ReturnType<typeof Table.make<Name, S>>["identifier"], Version, Transition>
    repository: Repository
  }>,
) => {

  const {
    noTransitionChanges,
    operations,
    repository,
    table,
  } = context

  const {
    createInputSchema,
    createWireSchema,
    identifierWireSchema,
    canonicalRowWireSchema,
    PageSchema,
    listWireSchema,
    patchInputSchema,
    patchWireSchema,
    transitionInputSchema,
    errorSchema,
    transitionErrorSchema,
  } = makeResourceContractSchemas(options, context)

  const identifierFrom = (input: StructValue) => {
    const identifier = pipe(Record.get(input, table.identifier), Option.getOrThrow)

    return narrowContract<ReturnType<typeof Table.make<Name, S>>["identifierSchema"]["Type"], typeof identifier>(
      identifier,
    )
  }

  const getHandler = flow(identifierFrom, repository.get)
  const removeHandler = flow(identifierFrom, repository.remove)

  const expectedVersions = (input: StructValue): [...ExpectedVersion<Version>] => {
    const supplied = Record.get(input, "expectedVersion")
    const integer = Option.filter(supplied, Schema.is(Schema.Int))
    const versions = Option.match(integer, { onNone: () => [] as const, onSome: (value) => [value] as const })

    return narrowContract<[...ExpectedVersion<Version>], typeof versions>(versions)
  }

  const patchOperation = (input: typeof patchInputSchema.Type) => {
    const versions = expectedVersions(input)

    return repository.patch(input.key, input.changes, ...versions)
  }

  const transitionOperation = (input: typeof transitionInputSchema.Type) => {
    const changes = input.changes ?? noTransitionChanges
    const versions = expectedVersions(input)

    return repository.transition(input.key, input.action, changes, ...versions)
  }

  const makeResourceRpc = <
    const Operation extends ResourceOperation,
    Payload extends Schema.Top,
    Success extends Schema.Top,
    Error extends Schema.Top,
  >(operation: Operation, payload: Payload, success: Success, error: Error) =>
    Rpc.make(`${options.name}.${operation}`, { payload, success, error })

  const getRpc = makeResourceRpc("get", identifierWireSchema, canonicalRowWireSchema, errorSchema)
  const listRpc = makeResourceRpc("list", listWireSchema, PageSchema, errorSchema)
  const createRpc = makeResourceRpc("create", createWireSchema, canonicalRowWireSchema, errorSchema)
  const updateRpc = makeResourceRpc("update", canonicalRowWireSchema, canonicalRowWireSchema, errorSchema)
  const patchRpc = makeResourceRpc("patch", patchWireSchema, canonicalRowWireSchema, errorSchema)
  const removeRpc = makeResourceRpc("remove", identifierWireSchema, Schema.Void, errorSchema)
  const transitionRpc = makeResourceRpc("transition", transitionInputSchema, canonicalRowWireSchema, transitionErrorSchema)

  const contracts = Object.freeze({
    get: getRpc,
    list: listRpc,
    create: createRpc,
    update: updateRpc,
    patch: patchRpc,
    remove: removeRpc,
    transition: transitionRpc,
  })

  const definitions = new Data.Class({
    get: { rpc: contracts.get, handler: getHandler },
    list: { rpc: contracts.list, handler: repository.list },
    create: { rpc: contracts.create, handler: repository.create },
    update: { rpc: contracts.update, handler: repository.update },
    patch: { rpc: contracts.patch, handler: patchOperation },
    remove: { rpc: contracts.remove, handler: removeHandler },
    transition: { rpc: contracts.transition, handler: transitionOperation },
  })

  type Operation = PublishedOperation<Operations>
  type SelectedRpc = Extract<typeof definitions[ResourceOperation]["rpc"], { readonly _tag: `${Name}.${Operation}` }>

  const publishedRpcs = Array.map(operations, (operation) => definitions[operation].rpc)
  const selected = narrowContract<Array<SelectedRpc>, typeof publishedRpcs>(publishedRpcs)
  const selectedGroup: RpcGroup.RpcGroup<SelectedRpc> = RpcGroup.make(...selected)

  type PublishedRpc = Auth extends PolicyAuthorization ? Rpc.AddMiddleware<SelectedRpc, typeof AuthorizationRpc> : SelectedRpc

  const authorizedGroup = Equivalence.strictEqual()(options.authorization._tag, "Policy")
    ? selectedGroup.middleware(AuthorizationRpc)
    : selectedGroup

  const group = narrowContract<RpcGroup.RpcGroup<PublishedRpc>, typeof authorizedGroup>(authorizedGroup)
  const handlerEntries = Array.map(operations, (operation) => [`${options.name}.${operation}`, definitions[operation].handler] as const)
  const handlerRecord = Record.fromEntries(handlerEntries)

  const typedHandlerRecord = narrowContract<
    typeof handlerRecord & RpcGroup.HandlersFrom<SelectedRpc>,
    typeof handlerRecord
  >(handlerRecord)

  const handlerLayer = selectedGroup.toLayer(typedHandlerRecord)

  const handlers = narrowContract<
    Layer.Layer<Rpc.ToHandler<SelectedRpc>, never, Effect.Services<ReturnType<typeof definitions[Operation]["handler"]>>>,
    typeof handlerLayer
  >(handlerLayer)


  return {
    contracts,
    createInputSchema,
    group,
    handlers,
  }
}
