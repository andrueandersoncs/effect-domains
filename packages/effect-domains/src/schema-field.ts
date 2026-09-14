import { Array, Data, Equivalence, Function, HashSet, Match, Option, Predicate, Schema, SchemaAST, Struct, Tuple, flow, pipe } from "effect"

/** Retain original AST evidence because canonical and physical interpretations are different. */
export type ScalarF<A> = Data.TaggedEnum<{
  Leaf: { readonly ast: SchemaAST.AST }
  Unsupported: { readonly ast: SchemaAST.AST }
  Encoding: { readonly ast: SchemaAST.AST; readonly value: A }
  Suspend: { readonly ast: SchemaAST.AST; readonly value: A }
  Collection: { readonly ast: SchemaAST.AST; readonly value: A }
  Union: { readonly ast: SchemaAST.AST; readonly members: ReadonlyArray<A> }
}>

const Nodes = Data.taggedEnum<ScalarF<SchemaAST.AST>>()

const transformLayer = <A, B>(layer: ScalarF<A>, f: (child: A) => B): ScalarF<B> => pipe(
  Match.value(layer),
  Match.tag("Leaf", "Unsupported", (leaf) => leaf),
  Match.tag("Encoding", "Suspend", "Collection", (node) => {
    const value = f(node.value)
    return Struct.assign(node, { value })
  }),
  Match.tag("Union", (node) => {
    const members = Array.map(node.members, f)
    return Struct.assign(node, { members })
  }),
  Match.exhaustive,
)

const project = (ast: SchemaAST.AST, storage: boolean): ScalarF<SchemaAST.AST> => {
  const encoded = storage && ast.encoding

  if (encoded) {
    const value = SchemaAST.toEncoded(ast)
    return Nodes.Encoding({ ast, value })
  }

  return pipe(Match.value(ast),
    Match.tag("Suspend", (ast) => {
      const value = ast.thunk()
      return Nodes.Suspend({ ast, value })
    }),
    Match.tag("Union", (ast) => pipe(ast, Struct.get("types"), (members) => Nodes.Union({ ast, members }))),
    Match.tag("Arrays", (ast) => {
      const single = Equivalence.strictEqual<number>()(ast.rest.length, 1)
      const homogeneous = Array.isReadonlyArrayEmpty(ast.elements) && single
      const canonical = !storage
      const supported = canonical && homogeneous
      if (!supported) return Nodes.Unsupported({ ast })
      const value = pipe(Array.head(ast.rest), Option.getOrThrow)
      return Nodes.Collection({ ast, value })
    }),
    Match.orElse((ast) => Nodes.Leaf({ ast })),
  )
}

/** Follow encoding only for storage because canonical callers already select toType. */
const fold = <A>(mode: "canonical" | "storage", algebra: (layer: ScalarF<A>) => A) => {
  const storage = Equivalence.strictEqual<typeof mode>()(mode, "storage")

  const visit = (seen: HashSet.HashSet<SchemaAST.AST>) => (ast: SchemaAST.AST): A => {
    if (HashSet.has(seen, ast)) return pipe(Nodes.Unsupported({ ast }), algebra)
    const next = HashSet.add(seen, ast)
    const layer = project(ast, storage)
    return pipe(transformLayer(layer, visit(next)), algebra)
  }

  return pipe(HashSet.empty<SchemaAST.AST>(), visit)
}

// Read only data properties because check metadata must not invoke authored getters.
export const ownValue = (value: unknown, key: string): unknown => {
  const descriptor = Predicate.isObject(value) ? Object.getOwnPropertyDescriptor(value, key) : null
  return descriptor?.value
}

const flattenChecks = (check: SchemaAST.Check<unknown>): ReadonlyArray<SchemaAST.Filter<unknown>> =>
  pipe(Match.value(check), Match.tagsExhaustive({
    FilterGroup: (group) => Array.flatMap(group.checks, flattenChecks),
    Filter: (filter) => [filter],
  }))

export const scalarChecks = (ast: SchemaAST.AST) => Array.flatMap(ast.checks ?? [], flattenChecks)

export type FieldCategory = "string" | "number" | "boolean"

/** Canonical scalar evidence shared by authorization, persistence, and read models. */
export class FieldIR extends Data.Class<{
  readonly category: Option.Option<FieldCategory>
  readonly nullable: boolean
  readonly collection: boolean
  readonly transformsStoredNull: boolean
}> {}

const emptyCategory = Option.none<FieldCategory>()
const describe = (
  category: Option.Option<FieldCategory>,
  nullable = false,
  collection = false,
  transformsStoredNull = false,
) => new FieldIR({ category, nullable, collection, transformsStoredNull })

const neutralDescription = describe(emptyCategory)
const nullDescription = describe(emptyCategory, true)
const optionalNull = Option.some(nullDescription)
const optionalString = pipe(Option.some<FieldCategory>("string"), describe, Option.some)
const optionalNumber = pipe(Option.some<FieldCategory>("number"), describe, Option.some)
const optionalBoolean = pipe(Option.some<FieldCategory>("boolean"), describe, Option.some)


const finiteNumber = (ast: SchemaAST.Number) => pipe(scalarChecks(ast), Array.some((check) => {
  const id = ownValue(check.annotations?.representation, "id")

  return Equivalence.strictEqual<unknown>()(id, "effect/schema/isFinite")
    || Equivalence.strictEqual<unknown>()(id, "effect/schema/isInt")
}))

export const describeLiteral = (value: unknown): Option.Option<FieldIR> => pipe(
  Match.value(value),
  Match.when(Predicate.isNull, Function.constant(optionalNull)),
  Match.when(Predicate.isString, Function.constant(optionalString)),
  Match.when(Predicate.isBoolean, Function.constant(optionalBoolean)),
  Match.when(Schema.is(Schema.Finite), Function.constant(optionalNumber)),
  Match.orElse(Option.none<FieldIR>),
)

const sameCategory = (
  left: Option.Option<FieldCategory>,
  right: Option.Option<FieldCategory>,
) => {
  const unrestricted = Option.isNone(left) || Option.isNone(right)
  const same = Option.makeEquivalence(Equivalence.strictEqual<unknown>())(left, right)
  return unrestricted || same
}

const combineDescriptions = (
  descriptions: ReadonlyArray<Option.Option<FieldIR>>,
) => {
  const merge = (left: FieldIR, right: FieldIR) => {
    const scalar = !right.collection
    const compatible = sameCategory(left.category, right.category)
    if (!scalar || !compatible) return Option.none<FieldIR>()
    const category = Option.orElse(left.category, Function.constant(right.category))
    return pipe(describe(
      category,
      left.nullable || right.nullable,
      left.collection,
      left.transformsStoredNull || right.transformsStoredNull,
    ), Option.some)
  }

  const reduce = (
    state: Option.Option<FieldIR>,
    next: Option.Option<FieldIR>,
  ) => pipe(Option.all([state, next] as const), Option.flatMap(Function.tupled(merge)))

  return Array.reduce(descriptions, Option.some(neutralDescription), reduce)
}

const asCollection = (field: FieldIR) =>
  new FieldIR({ ...field, collection: true })

const canonicalAlgebra = (
  layer: ScalarF<Option.Option<FieldIR>>,
): Option.Option<FieldIR> => {
  const classifyNumber = (number: SchemaAST.Number) =>
    finiteNumber(number) ? optionalNumber : Option.none<FieldIR>()

  const leaf = (ast: SchemaAST.AST) => pipe(
    Match.value(ast),
    Match.tag("String", "TemplateLiteral", Function.constant(optionalString)),
    Match.tag("Number", classifyNumber),
    Match.tag("Boolean", Function.constant(optionalBoolean)),
    Match.tag("Null", Function.constant(optionalNull)),
    Match.tag("Literal", flow(Struct.get<SchemaAST.Literal, "literal">("literal"), describeLiteral)),
    Match.tag(
      "Enum",
      flow(
        Struct.get<SchemaAST.Enum, "enums">("enums"),
        Array.map(flow(Tuple.get<readonly [string, string | number], 1>(1), describeLiteral)),
        combineDescriptions,
      ),
    ),
    Match.orElse(Option.none<FieldIR>),
  )

  return pipe(Match.value(layer), Match.tagsExhaustive({
    Leaf: ({ ast }) => leaf(ast),
    Unsupported: Option.none<FieldIR>,
    Encoding: Option.none<FieldIR>,
    Suspend: ({ value }) => value,
    Union: ({ members }) => combineDescriptions(members),
    Collection: ({ value }) => pipe(
      value,
      Option.filter(Predicate.not(Struct.get("collection"))),
      Option.map(asCollection),
    ),
  }))
}

export const describeValue = (
  value: unknown,
): Option.Option<FieldIR> => Array.isArray(value)
  ? pipe(value, Array.map(describeLiteral), combineDescriptions, Option.map(asCollection))
  : describeLiteral(value)

const storageNullAlgebra = (layer: ScalarF<boolean>) => pipe(
  Match.value(layer),
  Match.tag("Leaf", Function.constant(false)),
  Match.tag("Unsupported", Function.constant(true)),
  Match.tag("Suspend", "Collection", Struct.get<{ readonly value: boolean }, "value">("value")),
  Match.tag("Union", ({ members }) => Array.some(members, Function.identity)),
  Match.tag("Encoding", ({ ast, value }) => {
    const EncodedSchema = Schema.make(SchemaAST.toEncoded(ast))
    return Schema.is(EncodedSchema)(null) || value
  }),
  Match.exhaustive,
)

const canonical = fold("canonical", canonicalAlgebra)
const transformsStoredNull = fold("storage", storageNullAlgebra)

export const compileField = (schema: Schema.Constraint): Option.Option<FieldIR> => {
  const ast = SchemaAST.toType(schema.ast)
  if (SchemaAST.isOptional(ast)) return Option.none()
  return pipe(
    canonical(ast),
    Option.map((field) => new FieldIR({
      ...field,
      transformsStoredNull: transformsStoredNull(schema.ast),
    })),
  )
}

export const SchemaField = {
  map: transformLayer,
  fold,
  compile: compileField,
  describeLiteral,
  transformsStoredNull,
  describeValue,
}
export const ScalarSchema = { map: transformLayer, fold }
