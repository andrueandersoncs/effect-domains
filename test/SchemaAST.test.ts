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

const declarationTypeParameter = new SchemaAST.BigInt()

const declaration = new SchemaAST.Declaration(
  [declarationTypeParameter],
  () => () => Effect.succeed(undefined),
)

const unionString = new SchemaAST.String()
const unionNumber = new SchemaAST.Number()
const unionSuspend = new SchemaAST.Suspend(Function.constant(unionNumber))

const union = new SchemaAST.Union([unionString, unionSuspend], "anyOf")

const templateLiteralPrefix = new SchemaAST.Literal("item-")
const templateLiteralNumber = new SchemaAST.Number()

const templateLiteral = new SchemaAST.TemplateLiteral([
  templateLiteralPrefix,
  templateLiteralNumber,
])

const arrays = new SchemaAST.Arrays(false, [union], [templateLiteral])
const itemsProperty = new SchemaAST.PropertySignature("items", arrays)
const indexSignatureParameter = new SchemaAST.String()

const indexSignature = new SchemaAST.IndexSignature(
  indexSignatureParameter,
  declaration,
)

const root = new SchemaAST.Objects([itemsProperty], [indexSignature])

const CyclicSchema: Schema.Codec<never> = Schema.suspend(
  (): Schema.Codec<never> => CyclicSchema,
)

describe("SchemaAST evaluator", () => {
  it("folds every recursive child position", () => {
    const result = evaluate(root, countNodes, Function.constant(0))

    expect(result).toBe(12)
  })

  it("delegates suspended cycles to the algebra boundary", () => {
    const result = evaluate(CyclicSchema.ast, countNodes, Function.constant(40))

    expect(result).toBe(41)
  })
})
