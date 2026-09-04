import { describe, expect, it } from "@effect/vitest"
import { Effect, Function, Match, Number, Schema, SchemaAST, pipe } from "effect"
import {
  evaluate,
  type SchemaASTF,
  type SchemaASTFAlgebra,
} from "../src/schema-ast.ts"

const countLeaf = Function.constant(1)

const countNodes: SchemaASTFAlgebra<number> = pipe(
  Match.type<SchemaASTF<number>>(),
  Match.tagsExhaustive({
    Declaration: (declaration) =>
      1 + Number.sumAll(declaration.typeParameters),
    Null: countLeaf,
    Undefined: countLeaf,
    Void: countLeaf,
    Never: countLeaf,
    Unknown: countLeaf,
    Any: countLeaf,
    String: countLeaf,
    Number: countLeaf,
    Boolean: countLeaf,
    BigInt: countLeaf,
    Symbol: countLeaf,
    Literal: countLeaf,
    UniqueSymbol: countLeaf,
    ObjectKeyword: countLeaf,
    Enum: countLeaf,
    TemplateLiteral: (templateLiteral) =>
      1 + Number.sumAll(templateLiteral.parts),
    Arrays: (arrays) =>
      1 + Number.sumAll(arrays.elements) + Number.sumAll(arrays.rest),
    Objects: (objects) =>
      1 +
      Number.sumAll(objects.propertySignatures) +
      Number.sumAll(objects.indexSignatureParameters) +
      Number.sumAll(objects.indexSignatureTypes),
    Union: (union) => 1 + Number.sumAll(union.types),
    Suspend: (suspend) => 1 + suspend.thunk(),
  }),
)

const declaration = new SchemaAST.Declaration(
  [new SchemaAST.BigInt()],
  () => () => Effect.succeed(undefined),
)

const union = new SchemaAST.Union(
  [
    new SchemaAST.String(),
    new SchemaAST.Suspend(() => new SchemaAST.Number()),
  ],
  "anyOf",
)

const templateLiteral = new SchemaAST.TemplateLiteral([
  new SchemaAST.Literal("item-"),
  new SchemaAST.Number(),
])

const arrays = new SchemaAST.Arrays(false, [union], [templateLiteral])

const root = new SchemaAST.Objects(
  [new SchemaAST.PropertySignature("items", arrays)],
  [new SchemaAST.IndexSignature(new SchemaAST.String(), declaration)],
)

const CyclicSchema: Schema.Codec<never> = Schema.suspend(
  (): Schema.Codec<never> => CyclicSchema,
)

describe("SchemaAST evaluator", () => {
  it("folds every recursive child position", () => {
    expect(evaluate(root, countNodes, Function.constant(0))).toBe(12)
  })

  it("delegates suspended cycles to the algebra boundary", () => {
    expect(evaluate(CyclicSchema.ast, countNodes, Function.constant(40))).toBe(41)
  })
})
