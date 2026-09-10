import { Array, Data, Equivalence, HashSet, Match, Option, Predicate, SchemaAST, Struct, pipe } from "effect"

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
export const ScalarSchema = { map: transformLayer, fold }
