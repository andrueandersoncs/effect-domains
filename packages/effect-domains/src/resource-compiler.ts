import { Array, Effect, Function, Option, Predicate, Record, Struct, pipe } from "effect"
import { RepositoryAccess, RepositoryOrder, RepositorySelect, RepositoryStore, VersionConflict } from "./repository-store.ts"
import { type TableFieldName, type TableRelationsInput } from "./table.ts"
import { PageLimitSchema, type StructSchema, type StructValue } from "./domain.ts"
import { type AuthorizationAction, type AuthorizationDefinition } from "./authorization.ts"
import type { TransitionMachine } from "./transitions.ts"
import { type ResourceOperations, type CompatibleStorage, type CreationFrom, type ListFrom, type ListPolicy, invalidInput, type ResourceListRequest, Replacement, decodeVersion, noChanges, noVersion, isUniqueViolation, type ResourceDraft, type ExpectedVersion, type ResourceChanges, type TransitionChanges } from "./resource-model.ts"
import { prepareResource } from "./resource-compiler-prepare.ts"
import { compileResourceContracts } from "./resource-contracts.ts"
import { SqliteList } from "./sqlite-list.ts"

const compileResourceValue = <
  const Name extends string,
  const S extends StructSchema,
  const Storage extends StructSchema = S,
  const Auth extends AuthorizationDefinition = AuthorizationDefinition,
  const Operations extends ResourceOperations<S, Auth> = ResourceOperations<S, Auth>,
  const Version extends Extract<keyof S["fields"], string> | undefined = undefined,
  const Transition extends TransitionMachine | undefined = undefined,
>(options: Readonly<{ name: Name; schema: S; operations: Operations; authorization: Auth }> & Readonly<Partial<{
  storage: Storage
  relations: TableRelationsInput<TableFieldName<Storage>>
  version: Version
  transitions: Transition
}>> & CompatibleStorage<S, Storage>) => {
  type Creation = CreationFrom<Operations>
  type List = Extract<ListFrom<Operations>, ListPolicy<S>>
  type CanonicalTable = ReturnType<typeof import("./table.ts").Table.make<Name, S>>
  type CanonicalRow = CanonicalTable["rowSchema"]["Type"]
  type CanonicalKey = CanonicalTable["identifier"]
  type CanonicalId = CanonicalTable["identifierSchema"]["Type"]

  const {
    authorize,
    canonicalIdentifierSchema,
    canonicalRowSchema,
    creationPlan,
    decodeRow,
    definitionFailure,
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
    declaredOrder,
  } = prepareResource(options)

  const repositoryFailure = (cause: unknown) =>
    invalidInput(table.name, `repository codec failure: ${String(cause)}`)

  const createAuthorized = Effect.fn("Repository.create")(function* (
    store: RepositoryStore["Service"], permission: RepositoryAccess, input: ResourceDraft<S, Creation, Version>,
  ) {
    const complete = yield* creationPlan.materialize(input, permission.subject)
    const encoded = yield* encodeRow(complete)
    const next = Option.some(complete)

    yield* authorize("create", permission.subject, Option.none(), next)

    const stored = yield* store.insert(table, encoded)

    return yield* readable(permission.subject, stored)
  })

  const identifierOrder = new RepositoryOrder({ field: table.identifier, direction: "asc" as const })

  const selectKey = Effect.fn("Repository.selectKey")(function* (
    store: RepositoryStore["Service"], permission: RepositoryAccess, key: unknown,
  ) {
    const filter = Record.singleton(table.identifier, key)
    const range = Record.empty()
    const after = Option.none()
    const query = new RepositorySelect({ filter, range, order: [identifierOrder], after, limit: 1 })
    const rows = yield* store.select(table, query, permission)

    return Array.head(rows)
  })

  const findAuthorized = Effect.fn("Repository.find")(function* (
    store: RepositoryStore["Service"], permission: RepositoryAccess, key: CanonicalId,
  ) {
    const encoded = yield* encodeKey(key)
    const stored = yield* selectKey(store, permission, encoded)

    if (Option.isNone(stored)) return Option.none<CanonicalRow>()

    return yield* pipe(readable(permission.subject, stored.value), Effect.map(Option.some))
  })

  const getAuthorized = Effect.fn("Repository.get")(function* (
    store: RepositoryStore["Service"], permission: RepositoryAccess, key: CanonicalId,
  ) {
    const found = yield* findAuthorized(store, permission, key)

    if (Option.isNone(found)) return yield* missing(key)

    return found.value
  })

  const versionReplacement = (
    current: StructValue,
    candidate: StructValue,
    versionField: Option.Option<string>,
    expectedVersion: Option.Option<number>,
  ) => Option.match(versionField, {
    onNone: () => new Replacement({ next: candidate, expected: current }),
    onSome: (field) => {
      const expectedValue = Option.getOrThrow(expectedVersion)
      const next = Struct.assign(candidate, { [field]: expectedValue + 1 })
      const expected = Struct.assign(current, { [field]: expectedValue })

      return new Replacement({ next, expected })
    },
  })

  const replaceExisting = Effect.fn("Repository.replaceExisting")(function* (
    store: RepositoryStore["Service"], permission: RepositoryAccess, action: Extract<AuthorizationAction, "update" | "patch">,
    key: unknown, changes: StructValue, expectedVersion: Option.Option<number> = Option.none(), guard: StructValue = Record.empty(),
  ) {
    const encodedKey = yield* encodeKey(key)
    const stored = yield* selectKey(store, permission, encodedKey)

    if (Option.isNone(stored)) return yield* missing(key)

    const current = yield* decodeRow(stored.value)
    const candidate = action === "patch" ? Struct.assign(current, changes) : changes
    const versionField = Option.fromNullishOr(version)
    const versioned = versionReplacement(current, candidate, versionField, expectedVersion)

    const encodedExpected = yield* encodeRow(versioned.expected)
    const encoded = yield* encodeRow(versioned.next)

    const versionGuard = Option.match(versionField, {
      onNone: Record.empty,
      onSome: (field) => Record.singleton(field, encodedExpected[field]),
    })

    const currentValue = Option.some(current)
    const nextValue = Option.some(versioned.next)
    const updateGuard = Struct.assign(guard, versionGuard)

    yield* authorize(action, permission.subject, currentValue, nextValue)

    const updated = yield* store.update(table, encoded, permission, updateGuard)

    if (Option.isSome(updated)) return yield* readable(permission.subject, updated.value)

    return yield* Option.match(versionField, {
      onNone: () => missing(key),
      onSome: () => {
        const expectedValue = Option.getOrThrow(expectedVersion)

        return VersionConflict.make({ resource: table.name, key: String(key), expectedVersion: expectedValue })
      },
    })
  })

  const updateAuthorized = Effect.fn("Repository.update")(function* (
    store: RepositoryStore["Service"], permission: RepositoryAccess, value: typeof canonicalRowSchema.Type & StructValue,
  ) {
    const versionField = Option.fromNullishOr(version)

    const expected = yield* Option.match(versionField, {
      onNone: Function.constant(noVersion),
      onSome: (field) => pipe(decodeVersion(value[field]), Effect.map(Option.some)),
    })

    return yield* replaceExisting(store, permission, "update", value[table.identifier], value, expected)
  })

  const patchAuthorized = Effect.fn("Repository.patch")(function* (
    store: RepositoryStore["Service"], permission: RepositoryAccess, key: CanonicalId, changes: ResourceChanges<S, CanonicalKey, Version>, ...expectedVersions: ExpectedVersion<Version>
  ) {
    if (Record.has(changes, table.identifier)) return yield* inputFailure(`patch must not provide immutable field ${table.identifier}`)

    const expectedVersion = Array.head(expectedVersions)
    const hasVersion = !Predicate.isUndefined(version)
    const changesVersion = hasVersion && Record.has(changes, version)
    const missingExpectedVersion = hasVersion && Option.isNone(expectedVersion)
    const invalidVersion = changesVersion || missingExpectedVersion

    if (invalidVersion) return yield* inputFailure(`patch must provide expectedVersion and must not provide version ${version}`)

    return yield* replaceExisting(store, permission, "patch", key, changes, expectedVersion)
  })

  const removeAuthorized = Effect.fn("Repository.remove")(function* (
    store: RepositoryStore["Service"], permission: RepositoryAccess, key: CanonicalId,
  ) {
    const encoded = yield* encodeKey(key)
    const stored = yield* selectKey(store, permission, encoded)

    if (Option.isNone(stored)) return yield* missing(key)

    const current = yield* decodeRow(stored.value)
    const row = Option.some(current)

    yield* authorize("remove", permission.subject, row)

    const removed = yield* store.remove(table, encoded, permission)

    if (!removed) return yield* missing(key)
  })

  // SAFETY: Table columns are compiled from this resource's declared list fields.
  const storageField = (field: string) =>
    table.columns[field as keyof typeof table.columns].storageSchema
  const identifierColumn = table.columns[table.identifier as keyof typeof table.columns]
  const storedIdentifier = storageSchema.fields[table.identifier]
  const sameIdentifier = implicitIdentifier || canonicalIdentifierSchema === storedIdentifier
  const orderableIdentifier = "orderable" in identifierColumn && identifierColumn.orderable === true && sameIdentifier
  const invalidOrdering = !orderableIdentifier
  const supportsList = Boolean(options.operations.list)
  const unsupportedList = supportsList && invalidOrdering

  if (unsupportedList) {
    pipe(definitionFailure("list identifier must preserve canonical ordering in storage"), Effect.runSync)
  }

  const makeOrder = ([field, direction]: readonly [string, "asc" | "desc"]) =>
    new RepositoryOrder({ field, direction })

  const configuredOrder = Array.map(declaredOrder, makeOrder)

  const isIdentifierOrder = (entry: RepositoryOrder) =>
    entry.field === table.identifier

  const includesIdentifier = Array.some(configuredOrder, isIdentifierOrder)
  const order = includesIdentifier ? configuredOrder : Array.append(configuredOrder, identifierOrder)
  const cursorOrder = Array.map(order, ({ field, direction }) => [field, direction])

  const cursorScope = JSON.stringify({
    resource: table.name,
    filter: filterFields,
    range: rangeFields,
    order: cursorOrder,
  })

  const canonicalField = (field: string) => pipe(
    Record.get(options.schema.fields, field),
    Option.getOrThrow,
  )

  const invalidListLimit = (limit: number) => inputFailure(`list limit must be between 1 and ${limit}`)
  const invalidListFilter = (field: string) => inputFailure(`filter ${field} is not declared`)
  const invalidListRange = (field: string) => inputFailure(`range ${field} is not declared`)
  const invalidCursorError = inputFailure("invalid list cursor")
  const invalidListCursor = Function.constant(invalidCursorError)

  const listPlan = SqliteList.make({
    filter: filterFields,
    range: rangeFields,
    order,
    maximum,
    scope: cursorScope,
    canonicalField,
    storageField,
    limitSchema: PageLimitSchema,
    errors: {
      limit: invalidListLimit,
      filter: invalidListFilter,
      range: invalidListRange,
      invalidCursor: invalidListCursor,
      cursorMismatch: invalidListCursor,
      codec: repositoryFailure,
      cursorEncoding: repositoryFailure,
    },
  })

  const listAuthorized = Effect.fn("Repository.list")(function* (
    store: RepositoryStore["Service"], permission: RepositoryAccess, input: ResourceListRequest<S, List> = {},
  ) {
    if (!orderableIdentifier) return yield* inputFailure("list identifier must preserve canonical ordering in storage")

    const requestedFilter = (input.filter ?? Record.empty()) as RepositorySelect["filter"]
    const requestedRange = (input.range ?? Record.empty()) as RepositorySelect["range"]
    const requestedLimit = Option.fromNullishOr(input.limit)
    const requestedCursor = Option.fromNullishOr(input.cursor)

    const prepared = yield* listPlan.prepare<Storage["EncodingServices"]>(
      requestedFilter,
      requestedRange,
      requestedLimit,
      requestedCursor,
    )

    const rows = yield* store.select(table, prepared.query, permission)
    const readListRow = (row: StructValue) => readable(permission.subject, row)
    const decodeListRows = (stored: ReadonlyArray<StructValue>) => Effect.forEach(stored, readListRow)

    return yield* listPlan.page(prepared, rows, decodeListRows)
  })

  const noTransitionChanges = Struct.assign(noChanges, noChanges) as TransitionChanges<S, CanonicalKey, Version, Transition>

  const transitionAuthorized = Effect.fn("Repository.transition")(function* (
    store: RepositoryStore["Service"],
    permission: RepositoryAccess,
    key: CanonicalId,
    action: string,
    changes: TransitionChanges<S, CanonicalKey, Version, Transition> = noTransitionChanges,
    ...expectedVersions: ExpectedVersion<Version>
  ) {
    if (Predicate.isUndefined(transition)) return yield* inputFailure("resource does not declare transitions")

    const changesIdentifier = Record.has(changes, table.identifier)
    const changesTransition = Record.has(changes, transition.field)
    const versionField = Option.fromNullishOr(version)
    const changesVersion = Option.exists(versionField, (field) => Record.has(changes, field))
    const immutableChanges = changesIdentifier || changesTransition || changesVersion

    if (immutableChanges) return yield* inputFailure("transition changes contain an immutable field")

    const expectedVersionValue = Array.head(expectedVersions)
    const missingExpectedVersion = Option.isNone(expectedVersionValue)
    const needsExpectedVersion = Option.isSome(versionField) && missingExpectedVersion

    if (needsExpectedVersion) return yield* inputFailure("transition must provide expectedVersion")

    const encodedKey = yield* encodeKey(key)
    const stored = yield* selectKey(store, permission, encodedKey)

    if (Option.isNone(stored)) return yield* missing(key)

    const current = yield* decodeRow(stored.value)
    const keyText = String(key)
    const source = pipe(Record.get(current, transition.field), Option.getOrThrow)
    const sourceActual = String(source)
    const to = yield* transition.guard(action as never, keyText, sourceActual)
    const encodedCurrent = yield* encodeRow(current)
    const encodedStatus = pipe(Record.get(encodedCurrent, transition.field), Option.getOrThrow)
    const statusGuard = Record.singleton(transition.field, encodedStatus)
    const withChanges = Struct.assign(current, changes)
    const statusChange = Record.singleton(transition.field, to)
    const candidate = Struct.assign(withChanges, statusChange)
    const versioned = versionReplacement(current, candidate, versionField, expectedVersionValue)

    const encodedExpected = yield* encodeRow(versioned.expected)
    const encoded = yield* encodeRow(versioned.next)

    const versionGuard = Option.match(versionField, {
      onNone: Record.empty,
      onSome: (field) => Record.singleton(field, encodedExpected[field]),
    })

    const currentValue = Option.some(current)
    const nextValue = Option.some(versioned.next)
    const guard = Struct.assign(statusGuard, versionGuard)

    yield* authorize("transition", permission.subject, currentValue, nextValue)

    const updated = yield* store.update(table, encoded, permission, guard)

    if (Option.isSome(updated)) return yield* readable(permission.subject, updated.value)

    if (Option.isSome(versionField)) {
      const expectedValue = Option.getOrThrow(expectedVersionValue)
      return yield* VersionConflict.make({ resource: table.name, key: String(key), expectedVersion: expectedValue })
    }

    const refreshed = yield* selectKey(store, permission, encodedKey)

    if (Option.isNone(refreshed)) return yield* missing(key)

    const actual = yield* decodeRow(refreshed.value)
    const actualStatus = pipe(Record.get(actual, transition.field), Option.getOrThrow)
    const actualText = String(actualStatus)
    const transitionError = transition.invalid(action, keyText, actualText)

    return yield* Effect.fail(transitionError)
  })

  const find = withAccess("read", findAuthorized)
  const get = withAccess("read", getAuthorized)
  const list = withAccess("read", listAuthorized)
  const create = withAccess("create", createAuthorized)
  const update = withAccess("update", updateAuthorized)
  const patch = withAccess("patch", patchAuthorized)
  const remove = withAccess("remove", removeAuthorized)
  const transitionRepository = withAccess("transition", transitionAuthorized)

  const ensureCreateAuthorized = Effect.fn("Repository.ensureCreate")(function* (
    store: RepositoryStore["Service"], permission: RepositoryAccess, row: CanonicalRow,
  ) {
    const encoded = yield* encodeRow(row)
    const next = Option.some(row)

    yield* authorize("create", permission.subject, Option.none(), next)

    const stored = yield* store.insert(table, encoded)

    return yield* readable(permission.subject, stored)
  })

  const ensureCreate = withAccess("create", ensureCreateAuthorized)

  const ensure = Effect.fn("Repository.ensure")(function* (row: CanonicalRow & StructValue) {
    const key = row[table.identifier as CanonicalKey] as CanonicalId
    const found = yield* find(key)

    if (Option.isSome(found)) return found.value

    const recoverUniqueViolation = Effect.catchIf(isUniqueViolation, () => get(key))

    return yield* pipe(ensureCreate(row), recoverUniqueViolation)
  })

  const repository = { find, get, list, create, update, patch, remove, ensure, transition: transitionRepository }

  const {
    contracts,
    createInputSchema,
    group,
    handlers,
  } = compileResourceContracts(options, {
    canonicalIdentifierSchema,
    canonicalRowSchema,
    creationPlan,
    listSchema: listPlan.input,
    noTransitionChanges,
    operations,
    repository,
    table,
    transitionOption,
    version,
    versionOption,
  })

  return Struct.assign(options, {
    _tag: "CompiledResource" as const,
    operations,
    published,
    storage: storageSchema,
    table,
    creation: creationPlan.inspection,
    list: listPolicy,
    version,
    transitions: transition,
    createInputSchema,
    contracts,
    repository,
    group,
    handlers,
  })
}

export { compileResourceValue }
