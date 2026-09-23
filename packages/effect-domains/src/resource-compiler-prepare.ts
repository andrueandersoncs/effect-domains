import { Array, Data, Effect, Equal, flow, Option, Predicate, Record, Schema, Struct, pipe } from "effect"
import { RepositoryAccess, RepositoryError, ResourceNotFound } from "./repository-store.ts"
import { Table, type TableField, type TableFieldName, type TableRelationsInput, withImplicitIdentifier } from "./table.ts"
import { Creation } from "./resource-creation.ts"
import type { StructSchema, StructValue } from "./domain.ts"
import {
  Authorization,
  AuthorizationValues,
  type AuthorizationAction,
  type AuthorizationDefinition,
  type SubjectOperand,
} from "./authorization.ts"
import type { TransitionMachine } from "./transitions.ts"
import {
  absentAuthorizationValue,
  type CompatibleStorage,
  canonicalInteger,
  type CreationPolicy,
  decodeOperations,
  invalidInput,
  type ListField,
  type ListPolicy,
  integerRequired,
  type PublishedCapabilities,
  type PublishedOperation,
  ResourceDefinitionError,
  type ResourceOperation,
  type ResourceOperations,
  withAuthorization,
} from "./resource-model.ts"

export type ResourceCompilerOptions<
  Name extends string,
  S extends StructSchema,
  Storage extends StructSchema,
  Auth extends AuthorizationDefinition,
  Operations extends ResourceOperations<S, Auth>,
  Version extends Extract<keyof S["fields"], string> | undefined,
  Transition extends TransitionMachine | undefined,
> = Readonly<{ name: Name; schema: S; operations: Operations; authorization: Auth }> &
  Readonly<
    Partial<{
      storage: Storage
      relations: TableRelationsInput<TableFieldName<Storage>>
      version: Version
      transitions: Transition
    }>
  > &
  CompatibleStorage<S, Storage>

export const prepareResource = <
  const Name extends string,
  const S extends StructSchema,
  const Storage extends StructSchema = S,
  const Auth extends AuthorizationDefinition = AuthorizationDefinition,
  const Operations extends ResourceOperations<S, Auth> = ResourceOperations<S, Auth>,
  const Version extends Extract<keyof S["fields"], string> | undefined = undefined,
  const Transition extends TransitionMachine | undefined = undefined,
>(options: ResourceCompilerOptions<Name, S, Storage, Auth, Operations, Version, Transition>) => {
  type CanonicalTable = ReturnType<typeof Table.make<Name, S>>
  type CanonicalRow = CanonicalTable["rowSchema"]["Type"]

  const definitionFailure = (reason: string) => ResourceDefinitionError.make({ resource: options.name, reason })
  const inputFailure = (reason: string) => invalidInput(options.name, reason)
  const operationFailure = (error: Schema.SchemaError) => definitionFailure(error.message)

  const operationValues = pipe(
    decodeOperations(options.operations),
    Effect.mapError(operationFailure),
    Effect.runSync,
  )

  const operations = pipe(
    operationValues,
    Struct.keys,
    Array.filter((operation: ResourceOperation): operation is PublishedOperation<Operations> => {
      const value = options.operations[operation]
      const publication = Predicate.isBoolean(value) ? value : value?.publish

      return !Equal.equals(publication, false)
    }),
  )

  const isPublished = (operation: ResourceOperation) => Array.contains(operations, operation)
  const publishesGet = isPublished("get")
  const publishesList = isPublished("list")
  const publishesCreate = isPublished("create")
  const publishesUpdate = isPublished("update")
  const publishesRemove = isPublished("remove")
  const publishesPatch = isPublished("patch")
  const publishesTransition = isPublished("transition")

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const published = Object.freeze({
    get: publishesGet,
    list: publishesList,
    create: publishesCreate,
    update: publishesUpdate,
    remove: publishesRemove,
    patch: publishesPatch,
    transition: publishesTransition,
  }) as PublishedCapabilities<Operations>

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const creation = pipe(
    Option.fromNullishOr(options.operations.create),
    Option.filter(Predicate.isObject),
  ) as Option.Option<CreationPolicy<S, Auth>>
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const listConfiguration = pipe(
    Option.fromNullishOr(options.operations.list),
    Option.filter(Predicate.isObject),
  ) as Option.Option<ListPolicy<S>>
  const createPolicy = Option.getOrUndefined(creation)
  const declaredListPolicy = Option.getOrUndefined(listConfiguration)
  const storageSchema = options.storage ?? options.schema

  const table = Table.make<Name, S | Storage>({
    name: options.name,
    schema: storageSchema,
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    relations: options.relations as TableRelationsInput<TableFieldName<S | Storage>>,
  })

  const filterFields: ReadonlyArray<string> = declaredListPolicy?.filter ?? []
  const rangeFields: ReadonlyArray<string> = declaredListPolicy?.range ?? []
  const declaredOrder = declaredListPolicy?.order ?? []
  const maximum = declaredListPolicy?.limit ?? 50
  const versionOption = Option.fromNullishOr(options.version)
  const transitionOption = Option.fromNullishOr(options.transitions)
  const version = Option.getOrUndefined(versionOption)
  const transition = Option.getOrUndefined(transitionOption)

  const validateVersion = Option.match(versionOption, {
    onNone: () => Effect.void,
    onSome: (fieldName) => Effect.gen(function* () {
      const field = Array.findFirst(table.fields, ({ name }) => Equal.equals(name, fieldName))
      const canonical = Record.get(options.schema.fields, fieldName)
      const validField = Option.exists(field, integerRequired)
      const validCanonical = Option.exists(canonical, canonicalInteger)
      const mutable = !Equal.equals(fieldName, table.identifier)
      const valid = Array.every([validField, validCanonical, mutable], Boolean)

      if (!valid) {
        return yield* definitionFailure(`version ${fieldName} must be a non-nullable integer field`)
      }
    }),
  })

  Effect.runSync(validateVersion)
  const declaredDefaults: StructValue = createPolicy?.defaults ?? Record.empty()
  const declaredGenerated: Readonly<Record<string, "uuidV7" | "now" | "one">> =
    createPolicy?.generated ?? Record.empty()
  const subjectBindings: Readonly<Record<string, SubjectOperand<unknown>>> =
    createPolicy?.fromSubject ?? Record.empty()

  pipe(
    Authorization.validateSubjectBindings(options.authorization, options.schema, subjectBindings),
    Effect.mapError(({ reason }) => definitionFailure(reason)),
    Effect.runSync,
  )

  const isImplicitDefault = (field: TableField) => {
    const notIdentifier = !Equal.equals(field.name, table.identifier)

    return field.nullable && notIdentifier
  }

  const lacksConfiguredValue = (field: TableField) => {
    const defaulted = Record.has(declaredDefaults, field.name)
    const generated = Record.has(declaredGenerated, field.name)
    const subjectBound = Record.has(subjectBindings, field.name)
    const generatedOrDefaulted = defaulted || generated
    const configured = generatedOrDefaulted || subjectBound

    return !configured
  }

  const defaultEntry = (field: TableField) => [field.name, null] as const
  const implicitDefaultFields = pipe(
    table.fields,
    Array.filter(isImplicitDefault),
    Array.filter(lacksConfiguredValue),
  )
  const implicitDefaults = pipe(implicitDefaultFields, Array.map(defaultEntry), Record.fromEntries)
  const defaults = Struct.assign(implicitDefaults, declaredDefaults)

  const versionGenerated = Predicate.isUndefined(version)
    ? declaredGenerated
    : Record.set(declaredGenerated, version, "one" as const)

  const listPolicy: ListPolicy<S> = new Data.Class({
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    filter: filterFields as ReadonlyArray<ListField<S>>,
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    range: rangeFields as ReadonlyArray<ListField<S>>,
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    order: declaredOrder as ReadonlyArray<readonly [ListField<S>, "asc" | "desc"]>,
    limit: maximum,
  })

  const implicitIdentifier = !Record.has(options.schema.fields, table.identifier)
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  const canonicalRowSchema = (
    implicitIdentifier ? withImplicitIdentifier(options.schema) : options.schema
  ) as Schema.Codec<CanonicalRow, unknown, S["DecodingServices"], S["EncodingServices"]>
  const declaredIdentifierSchema = Record.get(options.schema.fields, table.identifier)
  const canonicalIdentifierSchema = Option.getOrElse(declaredIdentifierSchema, () => table.identifierSchema)
  const authorization = pipe(
    Authorization.compile({
      authorization: options.authorization,
      resource: options.schema,
      storage: storageSchema,
      table,
    }),
    Effect.runSync,
  )

  const authorize = (
    action: AuthorizationAction,
    subject: StructValue,
    row: AuthorizationValues["row"],
    next: AuthorizationValues["next"] = absentAuthorizationValue,
  ) => {
    const values = new AuthorizationValues({ row, next })

    return pipe(
      authorization.check(action, subject, values),
      Effect.catchTag("PolicyEvaluationError", () => RepositoryError.make({ resource: table.name })),
    )
  }

  const repositoryFailure = (_cause: Schema.SchemaError) => RepositoryError.make({ resource: table.name })
  const isCanonical = Schema.is(canonicalRowSchema)
  const canonicalFailure = inputFailure("value does not satisfy the canonical schema")
  const validateCanonical = (value: unknown) =>
    isCanonical(value) ? Effect.succeed(value) : Effect.fail(canonicalFailure)
  const encodeKey = flow(
    Schema.encodeUnknownEffect(table.identifierStorageSchema),
    Effect.mapError(repositoryFailure),
  )
  const encodeStorage = flow(
    Schema.encodeUnknownEffect(table.storageSchema),
    Effect.mapError(repositoryFailure),
  )
  const encodeRow = flow(validateCanonical, Effect.flatMap(encodeStorage))
  const decodeRow = flow(
    Schema.decodeUnknownEffect(table.storageSchema),
    Effect.mapError(repositoryFailure),
    Effect.flatMap(validateCanonical),
  )
  const missing = (key: unknown) => ResourceNotFound.make({ resource: table.name, key: String(key) })
  const withAccess = withAuthorization<Auth>(authorization, table)

  const readable = Effect.fn("Repository.readable")(function* (
    subject: RepositoryAccess["subject"],
    stored: unknown,
  ) {
    const result = yield* decodeRow(stored)
    const row = Option.some(result)

    yield* authorize("read", subject, row)

    return result
  })

  const creationSchema = implicitIdentifier ? withImplicitIdentifier(options.schema) : options.schema
  const generatedIdentifier = implicitIdentifier ? Option.some(table.identifier) : Option.none<string>()
  const creationPlan = pipe(
    Creation.compile(
      creationSchema.fields,
      defaults,
      versionGenerated,
      subjectBindings,
      definitionFailure,
      inputFailure,
      generatedIdentifier,
    ),
    Effect.runSync,
  )

  return {
    authorize,
    canonicalIdentifierSchema,
    canonicalRowSchema,
    creationPlan,
    definitionFailure,
    declaredOrder,
    decodeRow,
    encodeKey,
    encodeRow,
    filterFields,
    implicitIdentifier,
    inputFailure,
    listPolicy,
    maximum,
    missing,
    operations,
    published,
    rangeFields,
    readable,
    storageSchema,
    table,
    transition,
    transitionOption,
    version,
    versionOption,
    withAccess,
  }
}
