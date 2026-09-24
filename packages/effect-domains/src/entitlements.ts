import { Array, Clock, Context, Data, DateTime, Effect, Equivalence, Function, HashMap, Layer, Match, Option, Predicate, Record, Schema, Struct, Tuple, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { StructSchema, StructValue } from "./domain.ts"
import type { Scalar } from "./policy.ts"
import type { Table } from "./table-relations.ts"


type StringField<Value> = Extract<keyof Value, string>

type CompatibleSubjectField<Subject, Value> = {
  [Field in StringField<Subject>]-?:
    Readonly<Record<never, never>> extends Pick<Subject, Field>
      ? never
      : Subject[Field] extends Value ? Field : never
}[StringField<Subject>]

type SubjectScope<
  Subject extends StructSchema,
  Source extends Table,
> = Readonly<Partial<{
  [Field in StringField<Source["storageSchema"]["Type"]>]:
    CompatibleSubjectField<Subject["Type"], Source["storageSchema"]["Type"][Field]>
}>>

const GrantScalarSchema: Schema.Codec<Scalar> = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
])

const GrantLiteralSchema = Schema.TaggedStruct("Literal", { value: GrantScalarSchema })
const GrantRowFieldSchema = Schema.TaggedStruct("RowField", { field: Schema.String })
const GrantNowSchema = Schema.TaggedStruct("Now", {})
const GrantOperandSchema = Schema.Union([GrantLiteralSchema, GrantRowFieldSchema, GrantNowSchema])

type GrantOperand = Schema.Schema.Type<typeof GrantOperandSchema>

const GrantEqualSchema = Schema.TaggedStruct("Equal", { left: GrantOperandSchema, right: GrantOperandSchema })
const GrantLessThanSchema = Schema.TaggedStruct("LessThan", { left: GrantOperandSchema, right: GrantOperandSchema })

type GrantTerminal = Schema.Schema.Type<typeof GrantEqualSchema> | Schema.Schema.Type<typeof GrantLessThanSchema>

const grantAllLayer = <A extends Schema.Constraint>(child: A) => Schema.TaggedStruct("All", { children: Schema.Array(child) })
const grantAnyLayer = <A extends Schema.Constraint>(child: A) => Schema.TaggedStruct("Any", { children: Schema.Array(child) })

type Grant =
  | GrantTerminal
  | { readonly _tag: "All"; readonly children: ReadonlyArray<Grant> }
  | { readonly _tag: "Any"; readonly children: ReadonlyArray<Grant> }

export const GrantSchema: Schema.Codec<Grant> = Schema.suspend(() =>
  Schema.Union([GrantEqualSchema, GrantLessThanSchema, GrantAllSchema, GrantAnySchema]))

const GrantAllSchema = grantAllLayer(GrantSchema)
const GrantAnySchema = grantAnyLayer(GrantSchema)

declare const GrantValue: unique symbol

type TypedGrantOperand<Value> = GrantOperand & Readonly<Record<typeof GrantValue, Value>>
type GrantOperandValue<Value> = Value extends TypedGrantOperand<infer Inner> ? Inner : Value
type GrantInput = TypedGrantOperand<unknown> | Scalar

type GrantKind<Value> =
  Exclude<Value, null> extends string ? "string"
    : Exclude<Value, null> extends number ? "number"
    : Exclude<Value, null> extends boolean ? "boolean"
    : Exclude<Value, null> extends DateTime.Utc ? "datetime"
    : never

type CompatibleGrant<Left, Right> =
  GrantKind<GrantOperandValue<Left>> extends GrantKind<GrantOperandValue<Right>> ? unknown : never

const grantLiteral = <Value extends Scalar>(value: Value) =>
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  GrantLiteralSchema.make({ value }) as TypedGrantOperand<Value>

const grantOperand = <Value extends GrantInput>(value: Value) =>
  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  Predicate.hasProperty(value, "_tag") ? value as GrantOperand : grantLiteral(value as Scalar)

const grantEqual = <Left extends GrantInput, Right extends GrantInput>(
  left: Left,
  right: Right & CompatibleGrant<Left, Right>,
) => GrantEqualSchema.make({ left: grantOperand(left), right: grantOperand(right) })

const grantLessThan = <Left extends GrantInput, Right extends GrantInput>(
  left: Left,
  right: Right & CompatibleGrant<Left, Right>,
) => GrantLessThanSchema.make({ left: grantOperand(left), right: grantOperand(right) })

const grantAll = (...children: ReadonlyArray<Grant>) => GrantAllSchema.make({ children })
const grantAny = (...children: ReadonlyArray<Grant>) => GrantAnySchema.make({ children })


const GrantRowSchema = Schema.Record(Schema.String, Schema.Unknown)
const UtcPairSchema = Schema.Tuple([Schema.DateTimeUtc, Schema.DateTimeUtc])
const NumberPairSchema = Schema.Tuple([Schema.Number, Schema.Number])
const StringPairSchema = Schema.Tuple([Schema.String, Schema.String])
const ComparablePairSchema = Schema.Union([NumberPairSchema, StringPairSchema])

const isUtcPair = Schema.is(UtcPairSchema)
const isComparablePair = Schema.is(ComparablePairSchema)

const utcPairLessThan = (values: Schema.Schema.Type<typeof UtcPairSchema>) => {
  const left = Tuple.get(values, 0)
  const right = Tuple.get(values, 1)
  const leftMillis = DateTime.toEpochMillis(left)
  const rightMillis = DateTime.toEpochMillis(right)

  return leftMillis < rightMillis
}

const grantValue = (
  operand: GrantOperand,
  row: StructValue,
  now: DateTime.Utc,
) =>
  pipe(
    Match.value(operand),
    Match.tagsExhaustive({
      Literal: ({ value }) => value,
      Now: Function.constant(now),
      RowField: ({ field }) => row[field],
    }),
  )

const grantValuesEqual = (left: unknown, right: unknown) => {
  const values = Tuple.make(left, right)

  if (isUtcPair(values)) {
    const leftDate = Tuple.get(values, 0)
    const rightDate = Tuple.get(values, 1)
    const leftMillis = DateTime.toEpochMillis(leftDate)
    const rightMillis = DateTime.toEpochMillis(rightDate)

    return Equivalence.strictEqual<number>()(leftMillis, rightMillis)
  }

  return Equivalence.strictEqual<unknown>()(left, right)
}

const grantValueLessThan = (left: unknown, right: unknown) => {
  const values = Tuple.make(left, right)

  const comparableValuesLessThan =
    isComparablePair(values) && Tuple.get(values, 0) < Tuple.get(values, 1)

  return isUtcPair(values) ? utcPairLessThan(values) : comparableValuesLessThan
}

const evaluateGrant = (
  grant: Grant,
  row: StructValue,
  now: DateTime.Utc,
): boolean => {
  const evaluateChild = (child: Grant) => evaluateGrant(child, row, now)

  return pipe(
    Match.value(grant),
    Match.tagsExhaustive({
      Equal: ({ left, right }) => {
        const leftValue = grantValue(left, row, now)
        const rightValue = grantValue(right, row, now)

        return grantValuesEqual(leftValue, rightValue)
      },
      LessThan: ({ left, right }) => {
        const leftValue = grantValue(left, row, now)
        const rightValue = grantValue(right, row, now)

        return grantValueLessThan(leftValue, rightValue)
      },
      All: ({ children }) => Array.every(children, evaluateChild),
      Any: ({ children }) => Array.some(children, evaluateChild),
    }),
  )
}

// SAFETY: Narrowing intersects the source because entitlement erasure retains the declaration that proves each runtime contract.
const narrowContract = <Target, Source>(value: Source) => value as Source & Target

class EntitlementSource<
  Subject extends StructSchema = StructSchema,
  Source extends Table = Table,
  const Key extends StringField<Source["storageSchema"]["Type"]> = StringField<Source["storageSchema"]["Type"]>,
> extends Data.Class<{
  readonly name: string
  readonly table: Source
  readonly subject: Subject
  readonly key: Key
  readonly scope: SubjectScope<Subject, Source>
  readonly grant: Grant
}> {}

export class EntitlementRequired extends Schema.TaggedError<EntitlementRequired>()("EntitlementRequired", { entitlement: Schema.String }) {}
export class EntitlementUnavailable extends Schema.TaggedError<EntitlementUnavailable>()("EntitlementUnavailable", {}) {}
class EntitlementDefinitionError extends Schema.TaggedError<EntitlementDefinitionError>()("EntitlementDefinitionError", { reason: Schema.String }) {}


type HasRequest = Readonly<{
  name: string
  key: string
  subject: StructValue
}>

type Has = (request: HasRequest) => Effect.Effect<boolean, EntitlementUnavailable>

const noEntitlement: Effect.Effect<boolean> = Effect.succeed(false)
const unavailable = () => EntitlementUnavailable.make({})
const invalidDefinition = (reason: string) => EntitlementDefinitionError.make({ reason })

/** Erased view over any concrete source because the resolver dispatches by name at runtime. */
interface AnyEntitlementSource {
  readonly name: string
  readonly table: Table
  readonly subject: StructSchema
  readonly key: string
  readonly scope: Readonly<Partial<Record<string, string>>>
  readonly grant: Grant
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

const failureForName = Effect.fn("Entitlements.failureForName")(function* (name: string) {
  const reason = isEmptyName(name) ? "entitlement name must not be empty" : `duplicate entitlement name ${name}`
  const failure = invalidDefinition(reason)

  return yield* Effect.fail(failure)
})

const validation = Effect.fn("Entitlements.validation")(function* (definitions: ReadonlyArray<AnyEntitlementSource>) {
  const names = Array.map(definitions, Struct.get("name"))
  const missing = Array.findFirst(names, isEmptyName)
  const duplicate = Array.findFirst(names, nameOccursMoreThanOnce(names))
  const invalidName = Option.orElse(missing, Function.constant(duplicate))

  return yield* Option.match(invalidName, {
    onNone: Function.constant(Effect.void),
    onSome: failureForName,
  })
})



const equality = (sql: SqlClient.SqlClient) => ([field, value]: readonly [string, unknown]) =>
  Predicate.isNull(value) ? sql`${sql(field)} IS NULL` : sql`${sql(field)} = ${value}`

const resolverEntry = (definition: AnyEntitlementSource) => [
  definition.name,
  { ...definition, scope: Object.freeze({ ...definition.scope }) },
] as const

const fromTables = <const Definitions extends ReadonlyArray<AnyEntitlementSource>>(
  definitions: Definitions,
): Layer.Layer<Entitlements, never, SqlClient.SqlClient> => {
  const validated = validation(definitions)

  Effect.runSync(validated)

  const entries = Array.map(definitions, resolverEntry)
  const resolvers = HashMap.fromIterable(entries)

  const service: Effect.Effect<Entitlements["Service"], never, SqlClient.SqlClient> = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const has: Has = Effect.fn("Entitlements.fromTables.has")(function* (request: HasRequest) {
      const found = HashMap.get(resolvers, request.name)

      if (Option.isNone(found)) return yield* noEntitlement

      const subjectSchema = narrowContract<Schema.ConstraintDecoder<StructValue, never>, typeof found.value.subject>(
        found.value.subject,
      )

      const subject = yield* pipe(
        Schema.decodeUnknownOption(subjectSchema)(request.subject),
        Effect.fromOption(unavailable),
      )

      const rawScopeEntries = Record.toEntries(found.value.scope)

      const scopeEntries = narrowContract<
        ReadonlyArray<readonly [string, string]>,
        typeof rawScopeEntries
      >(rawScopeEntries)

      const filterEntries = Array.map(
        scopeEntries,
        ([field, subjectField]) => Tuple.make(field, subject[subjectField]),
      )

      const filterPredicates = Array.map(filterEntries, equality(sql))
      const keyPredicate = equality(sql)([found.value.key, request.key])
      const predicates = [keyPredicate, ...filterPredicates]

      const rows = yield* pipe(
        sql<StructValue>`
          SELECT * FROM ${sql(found.value.table.name)}
          WHERE ${sql.and(predicates)}
          LIMIT 1
        `,
        Effect.mapError(unavailable),
      )

      const row = Array.get(rows, 0)

      if (Option.isNone(row)) return yield* noEntitlement

      const storageSchema = narrowContract<
        Schema.ConstraintDecoder<StructValue, never>,
        typeof found.value.table.storageSchema
      >(found.value.table.storageSchema)

      const decoded = yield* pipe(
        Schema.decodeUnknownOption(storageSchema)(row.value),
        Option.flatMap(Schema.decodeUnknownOption(GrantRowSchema)),
        Effect.fromOption(unavailable),
      )

      const milliseconds = yield* Clock.currentTimeMillis
      const instant = DateTime.make(milliseconds)
      const now = yield* pipe(instant, Effect.fromOption(unavailable))

      return evaluateGrant(found.value.grant, decoded, now)
    })

    return Entitlements.of({ has })
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
  readonly has: Has
}>()("@effect-domains/Entitlements") {
  static readonly require: (request: HasRequest) => Effect.Effect<void, EntitlementUnavailable | EntitlementRequired> = Effect.fn("Entitlements.require")(function* (request) {
    const service = yield* Effect.serviceOption(Entitlements)

    if (Option.isNone(service)) return yield* EntitlementUnavailable.make({})

    const allowed = yield* service.value.has(request)

    if (!Equivalence.strictEqual<boolean>()(allowed, true)) return yield* EntitlementRequired.make({ entitlement: request.name })
  })

  static readonly fromTables = fromTables
  static readonly fromTable = fromTable
  static readonly Source = EntitlementSource
  static readonly GrantSchema = GrantSchema
  static for<Source extends Table>(source: Source) {
    const rawRow = Record.map(source.columns, (_, field) => GrantRowFieldSchema.make({ field }))

    const row = narrowContract<{
      readonly [Field in StringField<Source["storageSchema"]["Type"]>]:
        TypedGrantOperand<Source["storageSchema"]["Type"][Field]> & Readonly<{ readonly _tag: "RowField" }>
    }, typeof rawRow>(rawRow)

    const rawNow = GrantNowSchema.make({})
    const now = narrowContract<TypedGrantOperand<DateTime.Utc>, typeof rawNow>(rawNow)

    return Object.freeze({
      row,
      now,
      eq: grantEqual,
      lt: grantLessThan,
      all: grantAll,
      any: grantAny,
      literal: grantLiteral,
    })
  }
}
