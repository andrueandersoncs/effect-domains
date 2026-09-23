import { Array, Data, Effect, flow, Function, Layer, Option, Predicate, Record, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { VersionConflict } from "./repository-store.ts"
import { Table } from "./table.ts"
import type { StructSchema, StructValue } from "./domain.ts"
import { Page } from "./page.ts"
import type { AuthorizationDefinition, PolicyAuthorization } from "./authorization.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import type { TransitionMachine } from "./transitions.ts"
import { type CreationFrom, type ExpectedVersion, ForbiddenFieldSchema, type ListFrom, type ListPolicy, type PublishedOperation, PublicResourceErrorSchema, type ResourceChanges, ResourceErrorSchema, type ResourceErrors, type ResourceListRequest, type ResourceOperation, type ResourceOperations, type ResourceDraft, type TransitionChanges } from "./resource-model.ts"
import { prepareResource, type ResourceCompilerOptions } from "./resource-compiler-prepare.ts"

export type ResourceRepository<Key, Row, Changes, TransitionChange, Version extends string | undefined> = Readonly<{
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
  type Creation = CreationFrom<Operations>
  type List = Extract<ListFrom<Operations>, ListPolicy<S>>
  type CanonicalTable = ReturnType<typeof Table.make<Name, S>>
  type CanonicalKey = CanonicalTable["identifier"]
  type CanonicalId = CanonicalTable["identifierSchema"]["Type"]

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

  const CreateInputStructSchema = Schema.Struct(creationPlan.inputFields)
  const createInputSchema = Schema.make<Schema.Codec<ResourceDraft<S, Creation, Version>, unknown, S["DecodingServices"], S["EncodingServices"]>>(CreateInputStructSchema.ast)
  const IdentifierRequestStructSchema = Schema.Record(Schema.Literal(table.identifier), canonicalIdentifierSchema)
  const identifierRequestSchema = Schema.make<Schema.Codec<Readonly<Record<CanonicalKey, CanonicalId>>, unknown, S["DecodingServices"], S["EncodingServices"]>>(IdentifierRequestStructSchema.ast)
  const canonicalRowWireSchema = Schema.toCodecJson(canonicalRowSchema)
  const createWireSchema = Schema.toCodecJson(createInputSchema)
  const identifierWireSchema = Schema.toCodecJson(identifierRequestSchema)
  const PageSchema = Page.schema(canonicalRowWireSchema)
  const listInputSchema = Schema.make<Schema.Codec<ResourceListRequest<S, List>, unknown, S["DecodingServices"], S["EncodingServices"]>>(listSchema.ast)
  const listWireSchema = Schema.toCodecJson(listInputSchema)
  const canonicalMutableFields = Record.remove(options.schema.fields, table.identifier)

  const mutableFields = Predicate.isUndefined(version)
    ? canonicalMutableFields
    : Record.remove(canonicalMutableFields, version as never)

  const optionalMutableFields = Record.map(mutableFields, Schema.optionalKey)
  const patchFields = Record.set(optionalMutableFields, table.identifier, ForbiddenFieldSchema)
  const PatchFieldsSchema = Schema.Struct(patchFields)

  const PatchInputStructSchema = Predicate.isUndefined(version)
    ? Schema.Struct({ key: canonicalIdentifierSchema, changes: PatchFieldsSchema })
    : Schema.Struct({ key: canonicalIdentifierSchema, expectedVersion: Schema.Int, changes: PatchFieldsSchema })

  const patchInputSchema = Schema.make<Schema.Codec<Readonly<{ key: CanonicalId; changes: ResourceChanges<S, CanonicalKey, Version> }> & Readonly<Partial<{ expectedVersion: number }>>, unknown, S["DecodingServices"], S["EncodingServices"]>>(PatchInputStructSchema.ast)
  const patchWireSchema = Schema.toCodecJson(patchInputSchema)

  const transitionFieldsSchema = (field: string) => {
    const optionalFields = Record.map(mutableFields, Schema.optionalKey)
    const immutableIdentifier = Record.set(optionalFields, table.identifier, ForbiddenFieldSchema)
    const transitionFields = Record.set(immutableIdentifier, field, ForbiddenFieldSchema)

    return Schema.Struct(transitionFields)
  }

  const TransitionFieldsSchema = Option.match(transitionOption, {
    onNone: Function.constant(PatchFieldsSchema),
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

  type TransitionInput = Readonly<{ key: CanonicalId; action: string }>
    & Readonly<Partial<{ changes: TransitionChanges<S, CanonicalKey, Version, Transition> }>>
    & (Version extends string ? Readonly<{ expectedVersion: number }> : unknown)

  const transitionJsonSchema = Schema.toCodecJson(transitionInputStructSchema)
  const transitionInputSchema = Schema.make<Schema.Codec<TransitionInput, unknown, S["DecodingServices"], S["EncodingServices"]>>(transitionJsonSchema.ast)
  const isPublic = options.authorization._tag === "Public"
  const resourceErrorsSchema = isPublic ? PublicResourceErrorSchema : ResourceErrorSchema
  const versionedErrorsSchema = Schema.Union([resourceErrorsSchema, VersionConflict])

  const errorSchema = Option.match(versionOption, {
    onNone: Function.constant(resourceErrorsSchema),
    onSome: Function.constant(versionedErrorsSchema),
  }) as ResourceErrors<Auth>

  type TransitionError = Transition extends { readonly Error: infer Declared extends Schema.Top } ? Declared : typeof Schema.Never

  const declaredTransitionErrors = Option.map(transitionOption, Struct.get("Error"))
  const declaredTransitionErrorSchema = Option.getOrElse(declaredTransitionErrors, Function.constant(Schema.Never)) as TransitionError
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
  type CanonicalTable = ReturnType<typeof Table.make<Name, S>>
  type CanonicalId = CanonicalTable["identifierSchema"]["Type"]

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

  const identifierFrom = (input: StructValue) => input[table.identifier] as CanonicalId
  const getHandler = flow(identifierFrom, repository.get)
  const removeHandler = flow(identifierFrom, repository.remove)

  const expectedVersions = (input: StructValue) => {
    const supplied = Record.get(input, "expectedVersion")
    const integer = Option.filter(supplied, Schema.is(Schema.Int))
    const versions = Option.match(integer, { onNone: () => [] as const, onSome: (value) => [value] as const })

    return versions as ExpectedVersion<Version>
  }

  const patchHandler = (input: typeof patchInputSchema.Type) => {
    const versions = expectedVersions(input)
    return repository.patch(input.key, input.changes, ...versions)
  }

  const transitionHandler = (input: typeof transitionInputSchema.Type) => {
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
    patch: { rpc: contracts.patch, handler: patchHandler },
    remove: { rpc: contracts.remove, handler: removeHandler },
    transition: { rpc: contracts.transition, handler: transitionHandler },
  })

  type Operation = PublishedOperation<Operations>
  type SelectedRpc = Extract<typeof definitions[ResourceOperation]["rpc"], { readonly _tag: `${Name}.${Operation}` }>

  const selected = Array.map(operations, (operation) => definitions[operation].rpc) as Array<SelectedRpc>
  const selectedGroup: RpcGroup.RpcGroup<SelectedRpc> = RpcGroup.make(...selected)

  type PublishedRpc = Auth extends PolicyAuthorization ? Rpc.AddMiddleware<SelectedRpc, typeof AuthorizationRpc> : SelectedRpc

  const group = (options.authorization._tag === "Policy"
    ? selectedGroup.middleware(AuthorizationRpc)
    : selectedGroup) as unknown as RpcGroup.RpcGroup<PublishedRpc>

  const handlerEntries = Array.map(operations, (operation) => [`${options.name}.${operation}`, definitions[operation].handler] as const)
  const handlerRecord = Record.fromEntries(handlerEntries)
  const handlers = selectedGroup.toLayer(handlerRecord as typeof handlerRecord & RpcGroup.HandlersFrom<SelectedRpc>) as Layer.Layer<Rpc.ToHandler<SelectedRpc>, never, Effect.Services<ReturnType<typeof definitions[Operation]["handler"]>>>

  return {
    contracts,
    createInputSchema,
    group,
    handlers,
  }
}
