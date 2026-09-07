import { Array, Effect, flow, Layer, Option, Predicate, Record, Schema, Struct, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { RepositoryError, RepositoryStore, ResourceNotFound } from "./repository-store.ts"
import { Table } from "./table.ts"

const EmptyPayloadSchema = Schema.Struct({})

interface EmptyPayload extends Schema.Schema.Type<typeof EmptyPayloadSchema> {}

const ResourceOperationSchema = Schema.Literals(["get", "list", "create", "update", "remove"])
type ResourceOperation = Schema.Schema.Type<typeof ResourceOperationSchema>
const ResourceErrorSchema = Schema.Union([RepositoryError, ResourceNotFound])

const makeRepository = <T extends Table>(table: T) => {
  const encodeKey = Schema.encodeEffect(table.identifierStorageSchema)
  const encodeInput = Schema.encodeEffect(table.insertSchema)
  const encodeRow = Schema.encodeEffect(table.storageSchema)
  const decodeRow = Schema.decodeUnknownEffect(table.storageSchema)
  const storageRowsSchema = Schema.Array(table.storageSchema)
  const decodeRows = Schema.decodeUnknownEffect(storageRowsSchema)

  const repositoryFailure = (cause: Schema.SchemaError) =>
    RepositoryError.make({ resource: table.name, cause })

  const invalid = flow(repositoryFailure, Effect.fail)

  const missing = (key: unknown) => {
    const stringKey = String(key)

    return ResourceNotFound.make({ resource: table.name, key: stringKey })
  }

  const find = Effect.fn("Repository.find")(
    function* (key: T["identifierSchema"]["Type"]) {
      const encoded = yield* encodeKey(key)
      const store = yield* RepositoryStore
      const stored = yield* store.find(table, encoded)
      if (Option.isNone(stored)) return Option.none<T["rowSchema"]["Type"]>()
      const row = yield* decodeRow(stored.value)

      return Option.some(row)
    },
    Effect.catchTag("SchemaError", invalid),
  )

  const get = Effect.fn("Repository.get")(function* (
    key: T["identifierSchema"]["Type"],
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
    Effect.catchTag("SchemaError", invalid),
  )

  const create = Effect.fn("Repository.create")(
    function* (value: T["schema"]["Type"]) {
      const encoded = yield* encodeInput(value)
      const store = yield* RepositoryStore
      const stored = yield* store.insert(table, encoded)

      return yield* decodeRow(stored)
    },
    Effect.catchTag("SchemaError", invalid),
  )

  const update = Effect.fn("Repository.update")(
    function* (value: T["rowSchema"]["Type"]) {
      const encoded = yield* encodeRow(value)
      const store = yield* RepositoryStore
      const stored = yield* store.update(table, encoded)
      if (Option.isNone(stored)) return yield* missing(encoded[table.identifier])

      return yield* decodeRow(stored.value)
    },
    Effect.catchTag("SchemaError", invalid),
  )

  const remove = Effect.fn("Repository.remove")(
    function* (key: T["identifierSchema"]["Type"]) {
      const encoded = yield* encodeKey(key)
      const store = yield* RepositoryStore
      const removed = yield* store.remove(table, encoded)
      if (!removed) return yield* missing(key)
    },
    Effect.catchTag("SchemaError", invalid),
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
