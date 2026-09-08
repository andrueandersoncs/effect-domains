import { Array, Effect, flow, Option, Predicate, Record, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { RepositoryError, RepositoryStore, ResourceNotFound } from "./repository-store.ts"
import { Table, type TableDefinition } from "./table.ts"

const EmptyPayloadSchema = Schema.Struct({})

interface EmptyPayload extends Schema.Schema.Type<typeof EmptyPayloadSchema> {}

const ResourceOperationSchema = Schema.Literals(["get", "list", "create", "update", "remove"])
type ResourceOperation = Schema.Schema.Type<typeof ResourceOperationSchema>
const ResourceErrorSchema = Schema.Union([RepositoryError, ResourceNotFound])

const makeRepository = <
  Name extends string,
  S extends Schema.Struct<Schema.Struct.Fields>,
  Key extends string,
  Row extends Schema.Struct<Schema.Struct.Fields>,
  Identifier extends Schema.Constraint,
>(table: TableDefinition<Name, S, Key, Row, Identifier>) => {
  const repositoryFailure = (cause: Schema.SchemaError) =>
    RepositoryError.make({ resource: table.name, cause })

  const encodeKey = flow(
    Schema.encodeEffect(table.identifierStorageSchema),
    Effect.mapError(repositoryFailure),
  )

  const encodeInput = flow(
    Schema.encodeEffect(table.insertSchema),
    Effect.mapError(repositoryFailure),
  )

  const encodeRow = flow(
    Schema.encodeEffect(table.storageSchema),
    Effect.mapError(repositoryFailure),
  )

  const decodeRow = flow(
    Schema.decodeUnknownEffect(table.storageSchema),
    Effect.mapError(repositoryFailure),
  )

  const storageRowsSchema = Schema.Array(table.storageSchema)

  const decodeRows = flow(
    Schema.decodeUnknownEffect(storageRowsSchema),
    Effect.mapError(repositoryFailure),
  )

  const missing = (key: unknown) => {
    const stringKey = String(key)

    return ResourceNotFound.make({ resource: table.name, key: stringKey })
  }

  const find = Effect.fn("Repository.find")(
    function* (key: Identifier["Type"]) {
      const encoded = yield* encodeKey(key)
      const store = yield* RepositoryStore
      const stored = yield* store.find(table, encoded)
      if (Option.isNone(stored)) return Option.none<Row["Type"]>()
      const row = yield* decodeRow(stored.value)

      return Option.some(row)
    },
  )

  const get = Effect.fn("Repository.get")(function* (
    key: Identifier["Type"],
  ) {
    const found = yield* find(key)
    if (Option.isNone(found)) return yield* missing(key)

    return found.value
  })

  const list = Effect.fn("Repository.list")(
    function* () {
      const store = yield* RepositoryStore
      const stored = yield* store.list(table)

      return yield* decodeRows(stored)
    },
  )

  const create = Effect.fn("Repository.create")(
    function* (value: S["Type"]) {
      const encoded = yield* encodeInput(value)
      const store = yield* RepositoryStore
      const stored = yield* store.insert(table, encoded)

      return yield* decodeRow(stored)
    },
  )

  const update = Effect.fn("Repository.update")(
    function* (value: Row["Type"]) {
      const encoded = yield* encodeRow(value)
      const store = yield* RepositoryStore
      const stored = yield* store.update(table, encoded)
      if (Option.isNone(stored)) return yield* missing(encoded[table.identifier])

      return yield* decodeRow(stored.value)
    },
  )

  const remove = Effect.fn("Repository.remove")(
    function* (key: Identifier["Type"]) {
      const encoded = yield* encodeKey(key)
      const store = yield* RepositoryStore
      const removed = yield* store.remove(table, encoded)
      if (!removed) return yield* missing(key)
    },
  )

  const repository = { find, get, list, create, update, remove }

  return repository
}

const ResourceOperationsSchema = Schema.Array(ResourceOperationSchema)

export class Resource extends Schema.Class<Resource>("Resource")({
  name: Schema.String,
  schema: Schema.Any,
  table: Schema.Any,
  operations: ResourceOperationsSchema,
  repository: Schema.Any,
  group: Schema.Any,
  handlers: Schema.Any,
}) {
  static override make<
    const Name extends string,
    const S extends Schema.Struct<Schema.Struct.Fields>,
    const Operations extends ReadonlyArray<ResourceOperation>,
  >(options: Readonly<{ name: Name; schema: S; operations: Operations }>) {
    const table = Table.make({ name: options.name, schema: options.schema })
    const repository = makeRepository(table)
    void repository.find
    void repository.get
    void repository.list
    void repository.create
    void repository.update
    void repository.remove

    const identifierLiteralSchema = Schema.Literal(table.identifier)

    const identifierRequestSchema = Schema.Record(
      identifierLiteralSchema,
      table.identifierSchema,
    )

    const identifierWireSchema = Schema.toCodecJson(identifierRequestSchema)
    const inputWireSchema = Schema.toCodecJson(table.schema)
    const rowWireSchema = Schema.toCodecJson(table.rowSchema)
    const rowsWireSchema = Schema.Array(rowWireSchema)

    const getProcedure = Rpc.make(`${options.name}.get`, {
      payload: identifierWireSchema,
      success: rowWireSchema,
      error: ResourceErrorSchema,
    })

    const listProcedure = Rpc.make(`${options.name}.list`, {
      payload: EmptyPayloadSchema,
      success: rowsWireSchema,
      error: ResourceErrorSchema,
    })

    const createProcedure = Rpc.make(`${options.name}.create`, {
      payload: inputWireSchema,
      success: rowWireSchema,
      error: ResourceErrorSchema,
    })

    const updateProcedure = Rpc.make(`${options.name}.update`, {
      payload: rowWireSchema,
      success: rowWireSchema,
      error: ResourceErrorSchema,
    })

    const removeProcedure = Rpc.make(`${options.name}.remove`, {
      payload: identifierWireSchema,
      success: Schema.Void,
      error: ResourceErrorSchema,
    })

    const identifierFrom = (input: typeof identifierRequestSchema.Type) =>
      input[table.identifier]

    const getHandler = flow(identifierFrom, repository.get)
    const removeHandler = flow(identifierFrom, repository.remove)

    const procedureFor = (operation: Operations[number]) =>
      ({
        get: getProcedure,
        list: listProcedure,
        create: createProcedure,
        update: updateProcedure,
        remove: removeProcedure,
      })[operation]

    const handlerFor = (operation: Operations[number]) =>
      ({
        get: getHandler,
        list: repository.list,
        create: repository.create,
        update: repository.update,
        remove: removeHandler,
      })[operation]

    const tagFor = (operation: Operations[number]) => `${options.name}.${operation}`

    const selectedHandlersSchema = Schema.declare(
      (value): value is RpcGroup.HandlersFrom<ReturnType<typeof procedureFor>> => {
        const isRecord = Predicate.isObject(value)

        if (isRecord) {
          const handlerForOperation = (operation: Operations[number]): boolean => {
            const tag = tagFor(operation)
            const handler = value[tag]

            return Predicate.isFunction(handler)
          }

          return Array.every(options.operations, handlerForOperation)
        }

        return isRecord
      },
    )

    const handlerEntry = (operation: Operations[number]) =>
      [tagFor(operation), handlerFor(operation)] as const

    const selected = Array.map(options.operations, procedureFor)
    const group = RpcGroup.make(...selected) as RpcGroup.RpcGroup<ReturnType<typeof procedureFor>>
    const handlerEntries = Array.map(options.operations, handlerEntry)
    const handlerRecord = Record.fromEntries(handlerEntries)
    const decodedHandlers = Schema.decodeUnknownEffect(selectedHandlersSchema)(handlerRecord)
    const implementationsByTag = pipe(decodedHandlers, Effect.orDie)
    const handlers = group.toLayer(implementationsByTag)

    return super.make({
      name: options.name,
      schema: options.schema,
      table,
      operations: options.operations,
      repository,
      group,
      handlers,
    }) as Struct.Assign<Resource, {
      name: Name
      schema: S
      table: typeof table
      operations: Operations
      repository: typeof repository
      group: typeof group
      handlers: typeof handlers
    }>
  }
}
