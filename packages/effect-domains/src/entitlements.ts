import { Array, Clock, Context, Data, DateTime, Effect, Equivalence, Function, HashMap, Layer, Match, Option, Predicate, Record, Schema, Struct, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { StructSchema, StructValue } from "./domain.ts"
import type { Scalar } from "./policy.ts"
import type { Table } from "./table.ts"


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
const isUtcPair = Schema.is(UtcPairSchema)
const isNumberPair = Schema.is(NumberPairSchema)
const isStringPair = Schema.is(StringPairSchema)

const grantValue = (
  operand: GrantOperand,
  row: StructValue,
  now: DateTime.Utc,
) => pipe(
  Match.value(operand),
  Match.tag("Literal", ({ value }) => value),
  Match.tag("Now", Function.constant(now)),
  Match.tag("RowField", ({ field }) => row[field]),
  Match.exhaustive,
)

const grantValuesEqual = (left: unknown, right: unknown) => pipe(
  [left, right] as const,
  Match.value,
  Match.when(isUtcPair, ([leftDate, rightDate]) => {
    const leftMillis = DateTime.toEpochMillis(leftDate)
    const rightMillis = DateTime.toEpochMillis(rightDate)

    return Equivalence.strictEqual<number>()(leftMillis, rightMillis)
  }),
  Match.orElse(([leftValue, rightValue]) =>
    Equivalence.strictEqual<unknown>()(leftValue, rightValue)),
)

const grantValueLessThan = (left: unknown, right: unknown) => pipe(
  [left, right] as const,
  Match.value,
  Match.when(isUtcPair, ([leftDate, rightDate]) => {
    const leftMillis = DateTime.toEpochMillis(leftDate)
    const rightMillis = DateTime.toEpochMillis(rightDate)

    return leftMillis < rightMillis
  }),
  Match.when(isNumberPair, ([leftNumber, rightNumber]) => leftNumber < rightNumber),
  Match.when(isStringPair, ([leftString, rightString]) => leftString < rightString),
  Match.orElse(Function.constant(false)),
)

const evaluateGrant = (
  grant: Grant,
  row: StructValue,
  now: DateTime.Utc,
): boolean => {
  const evaluateChild = (child: Grant) => evaluateGrant(child, row, now)

  return pipe(
    Match.value(grant),
    Match.tag("Equal", ({ left, right }) => {
      const leftValue = grantValue(left, row, now)
      const rightValue = grantValue(right, row, now)

      return grantValuesEqual(leftValue, rightValue)
    }),
    Match.tag("LessThan", ({ left, right }) => {
      const leftValue = grantValue(left, row, now)
      const rightValue = grantValue(right, row, now)

      return grantValueLessThan(leftValue, rightValue)
    }),
    Match.tag("All", ({ children }) => Array.every(children, evaluateChild)),
    Match.tag("Any", ({ children }) => Array.some(children, evaluateChild)),
    Match.exhaustive,
  )
}

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
export class EntitlementDefinitionError extends Schema.TaggedError<EntitlementDefinitionError>()("EntitlementDefinitionError", { reason: Schema.String }) {}


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

const failureForName = Effect.fn("Entitlements.failureForName")((name: string) => {
  const reason = isEmptyName(name) ? "entitlement name must not be empty" : `duplicate entitlement name ${name}`
  const failure = invalidDefinition(reason)

  return Effect.fail(failure)
})

const validation = Effect.fn("Entitlements.validation")((definitions: ReadonlyArray<AnyEntitlementSource>): Effect.Effect<void, EntitlementDefinitionError> => {
  const names = Array.map(definitions, (definition) => definition.name)
  const missing = Array.findFirst(names, isEmptyName)
  const duplicate = Array.findFirst(names, nameOccursMoreThanOnce(names))

  if (Option.isSome(missing)) return failureForName(missing.value)
  if (Option.isSome(duplicate)) return failureForName(duplicate.value)

  return Effect.void
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
  Effect.runSync(validation(definitions))

  const entries = Array.map(definitions, resolverEntry)
  const resolvers = HashMap.fromIterable(entries)

  const service: Effect.Effect<Entitlements["Service"], never, SqlClient.SqlClient> = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const has: Has = Effect.fn("Entitlements.fromTables.has")(function* (request: HasRequest) {
      const found = HashMap.get(resolvers, request.name)

      if (Option.isNone(found)) return false

      const definition = found.value
      // SAFETY: Entitlement definitions accept canonical application schemas, whose decoding services are provided when the table is compiled.
      const subjectSchema = definition.subject as unknown as Schema.ConstraintDecoder<unknown, never>
      const subject = yield* pipe(
        Schema.decodeUnknownOption(subjectSchema)(request.subject),
        Effect.fromOption(unavailable),
      )

      // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
      const scopeEntries = Record.toEntries(definition.scope) as
        ReadonlyArray<readonly [string, string]>

      const filterEntries = Array.map(
        scopeEntries,
        ([field, subjectField]) => [
          field,
          // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
          (subject as StructValue)[subjectField],
        ] as const,
      )

      const filterPredicates = Array.map(filterEntries, equality(sql))
      const keyPredicate = equality(sql)([definition.key, request.key])
      const predicates = [keyPredicate, ...filterPredicates]

      const rows = yield* pipe(
        sql<StructValue>`
          SELECT * FROM ${sql(definition.table.name)}
          WHERE ${sql.and(predicates)}
          LIMIT 1
        `,
        Effect.mapError(unavailable),
      )

      const row = Array.get(rows, 0)

      if (Option.isNone(row)) return false

      // SAFETY: Compiled table storage schemas have no unresolved decoding services at repository runtime.
      const storageSchema = definition.table.storageSchema as unknown as Schema.ConstraintDecoder<unknown, never>
      const decoded = yield* pipe(
        Schema.decodeUnknownOption(storageSchema)(row.value),
        Option.flatMap(Schema.decodeUnknownOption(GrantRowSchema)),
        Effect.fromOption(unavailable),
      )

      const milliseconds = yield* Clock.currentTimeMillis
      const now = yield* pipe(DateTime.make(milliseconds), Effect.fromOption(unavailable))

      return evaluateGrant(definition.grant, decoded, now)
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
    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    const row = Record.map(source.columns, (_, field) =>
      GrantRowFieldSchema.make({ field })) as {
      readonly [Field in StringField<Source["storageSchema"]["Type"]>]:
        TypedGrantOperand<Source["storageSchema"]["Type"][Field]> & Readonly<{ readonly _tag: "RowField" }>
    }

    // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
    const now = GrantNowSchema.make({}) as TypedGrantOperand<DateTime.Utc>

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
