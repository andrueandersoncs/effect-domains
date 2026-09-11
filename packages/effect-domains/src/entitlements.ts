import { Array, Clock, Context, Data, DateTime, Effect, Equivalence, Function, HashMap, Layer, Option, Predicate, Record, Schema, Struct, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { StructSchema } from "./domain.ts"
import type { Table } from "./table.ts"

class EntitlementSource<
  Subject extends StructSchema = StructSchema,
  Source extends Table = Table,
  const Key extends Extract<keyof Source["storageSchema"]["Type"], string> = Extract<keyof Source["storageSchema"]["Type"], string>,
> extends Data.Class<{
  readonly name: string
  readonly table: Source
  readonly subject: Subject
  readonly key: Key
  readonly where: {
    bivarianceHack(input: Subject["Type"]): Readonly<Record<string, unknown>>
  }["bivarianceHack"]
  readonly grant: {
    bivarianceHack(row: Source["storageSchema"]["Type"], now: DateTime.Utc): boolean
  }["bivarianceHack"]
}> {}

export class EntitlementRequired extends Schema.TaggedError<EntitlementRequired>()("EntitlementRequired", { entitlement: Schema.String }) {}
export class EntitlementUnavailable extends Schema.TaggedError<EntitlementUnavailable>()("EntitlementUnavailable", {}) {}
class EntitlementDefinitionError extends Schema.TaggedError<EntitlementDefinitionError>()("EntitlementDefinitionError", { reason: Schema.String }) {}

const granted = Equivalence.strictEqual<boolean>()
const noEntitlement = Effect.succeed(false)
const unavailable = () => EntitlementUnavailable.make({})
const invalidDefinition = (reason: string) => EntitlementDefinitionError.make({ reason })

/** Erased view over any concrete source because the resolver dispatches by name at runtime. */
interface AnyEntitlementSource {
  readonly name: string
  readonly table: Table
  readonly subject: StructSchema
  readonly key: string
  readonly where: { bivarianceHack(input: unknown): Readonly<Record<string, unknown>> }["bivarianceHack"]
  readonly grant: { bivarianceHack(row: unknown, now: DateTime.Utc): boolean }["bivarianceHack"]
}

const isEmptyName = (name: string) => {
  const trimmed = name.trim()
  return Equivalence.strictEqual()(trimmed.length, 0)
}


const equal = Equivalence.strictEqual<unknown>()

const sameName = (name: string) => (candidate: string) => equal(name, candidate)

const nameOccursMoreThanOnce = (names: ReadonlyArray<string>) => (name: string) => {
  const matching = Array.filter(names, sameName(name))
  return matching.length > 1
}

const failureForName = (name: string) => {
  const reason = isEmptyName(name) ? "entitlement name must not be empty" : `duplicate entitlement name ${name}`
  const failure = invalidDefinition(reason)
  return Effect.fail(failure)
}

const validation = (definitions: ReadonlyArray<AnyEntitlementSource>) => {
  const names = Array.map(definitions, Struct.get("name"))
  const missing = Array.findFirst(names, isEmptyName)
  const duplicate = Array.findFirst(names, nameOccursMoreThanOnce(names))
  const problem: Option.Option<string> = Option.orElse(missing, Function.constant(duplicate))
  return pipe(problem, Option.match({ onNone: Function.constant(Effect.void), onSome: failureForName }))
}



const equality = (sql: SqlClient.SqlClient) => ([field, value]: readonly [string, unknown]) =>
  Predicate.isNull(value) ? sql`${sql(field)} IS NULL` : sql`${sql(field)} = ${value}`

const resolverEntry = (definition: AnyEntitlementSource) => [definition.name, definition] as const

const fromTables = <const Definitions extends ReadonlyArray<AnyEntitlementSource>>(
  definitions: Definitions,
): Layer.Layer<Entitlements, never, SqlClient.SqlClient> => {
  const definitionsAreValid = validation(definitions)
  Effect.runSync(definitionsAreValid)

  const entries = Array.map(definitions, resolverEntry)
  const resolvers = HashMap.fromIterable(entries)

  const service = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const has = Effect.fn("Entitlements.fromTables.has")(function* (request: Parameters<Entitlements["Service"]["has"]>[0]) {
      const found = HashMap.get(resolvers, request.name)

      return yield* pipe(found, Option.match({
        onNone: Function.constant(noEntitlement),
        onSome: Effect.fn("Entitlements.fromTables.resolve")(function* (definition) {
          const subject = yield* pipe(
            Schema.decodeUnknownEffect(definition.subject)(request.subject),
            Effect.mapError(unavailable),
          )

          const filters = definition.where(subject)
          const filterEntries = Record.toEntries(filters)
          const filterPredicates = Array.map(filterEntries, equality(sql))
          const keyPredicate = equality(sql)([definition.key, request.key])
          const predicates = [keyPredicate, ...filterPredicates]

          const rows = yield* pipe(
            sql<Readonly<Record<string, unknown>>>`
              SELECT * FROM ${sql(definition.table.name)}
              WHERE ${sql.and(predicates)}
              LIMIT 1
            `,
            Effect.mapError(unavailable),
          )

          const row = Array.get(rows, 0)
          if (Option.isNone(row)) return !Option.isNone(row)

          const decoded = yield* pipe(
            Schema.decodeUnknownEffect(definition.table.storageSchema)(row.value),
            Effect.mapError(unavailable),
          )

          const milliseconds = yield* Clock.currentTimeMillis
          const now = yield* pipe(DateTime.make(milliseconds), Effect.fromOption(unavailable))
          return definition.grant(decoded, now)
        }),
      }))
    })

    return Entitlements.of({ has: has as Entitlements["Service"]["has"] })
  })

  return Layer.effect(Entitlements, service)
}

const fromTable = <
  const Subject extends StructSchema,
  const Source extends Table,
  const Key extends Extract<keyof Source["storageSchema"]["Type"], string>,
>(definition: EntitlementSource<Subject, Source, Key>) =>
  fromTables([definition])

export class Entitlements extends Context.Service<Entitlements, {
  readonly has: (request: Readonly<{
    name: string
    key: string
    subject: Readonly<Record<string, unknown>>
  }>) => Effect.Effect<boolean, EntitlementUnavailable>
}>()("@effect-domains/Entitlements") {
  static readonly require = Effect.fn("Entitlements.require")(function* (request: Parameters<Entitlements["Service"]["has"]>[0]) {
    const service = yield* Effect.serviceOption(Entitlements)
    if (Option.isNone(service)) return yield* EntitlementUnavailable.make({})
    const allowed = yield* service.value.has(request)
    if (!granted(allowed, true)) return yield* EntitlementRequired.make({ entitlement: request.name })
  })

  static readonly fromTables = fromTables
  static readonly fromTable = fromTable
  static readonly Source = EntitlementSource
}
