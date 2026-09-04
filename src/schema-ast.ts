import {
  Effect,
  Match,
  pipe,
  Predicate,
  Schema,
  SchemaAST,
} from "effect"

const declareSchemaAST = <A extends SchemaAST.AST>(
  isVariant: Predicate.Refinement<SchemaAST.AST, A>,
) => Schema.declare(Predicate.compose(SchemaAST.isAST, isVariant))

const SchemaASTFCases = {
  Declaration: { ast: declareSchemaAST(SchemaAST.isDeclaration) },
  Null: { ast: declareSchemaAST(SchemaAST.isNull) },
  Undefined: { ast: declareSchemaAST(SchemaAST.isUndefined) },
  Void: { ast: declareSchemaAST(SchemaAST.isVoid) },
  Never: { ast: declareSchemaAST(SchemaAST.isNever) },
  Unknown: { ast: declareSchemaAST(SchemaAST.isUnknown) },
  Any: { ast: declareSchemaAST(SchemaAST.isAny) },
  String: { ast: declareSchemaAST(SchemaAST.isString) },
  Number: { ast: declareSchemaAST(SchemaAST.isNumber) },
  Boolean: { ast: declareSchemaAST(SchemaAST.isBoolean) },
  BigInt: { ast: declareSchemaAST(SchemaAST.isBigInt) },
  Symbol: { ast: declareSchemaAST(SchemaAST.isSymbol) },
  Literal: { ast: declareSchemaAST(SchemaAST.isLiteral) },
  UniqueSymbol: { ast: declareSchemaAST(SchemaAST.isUniqueSymbol) },
  ObjectKeyword: { ast: declareSchemaAST(SchemaAST.isObjectKeyword) },
  Enum: { ast: declareSchemaAST(SchemaAST.isEnum) },
  TemplateLiteral: { ast: declareSchemaAST(SchemaAST.isTemplateLiteral) },
  Arrays: { ast: declareSchemaAST(SchemaAST.isArrays) },
  Objects: { ast: declareSchemaAST(SchemaAST.isObjects) },
  Union: { ast: declareSchemaAST(SchemaAST.isUnion) },
  Suspend: { ast: declareSchemaAST(SchemaAST.isSuspend) },
}

export const SchemaASTFSchema = Schema.TaggedUnion(SchemaASTFCases)

type SchemaASTF = Schema.Schema.Type<typeof SchemaASTFSchema>

export type SchemaASTFAlgebra<A> = {
  readonly [Tag in SchemaASTF["_tag"]]: (
    ast: Extract<SchemaASTF, { readonly _tag: Tag }>["ast"],
  ) => A
}

const decodeSchemaASTF = Schema.decodeUnknownEffect(SchemaASTFSchema)

export const evaluate = Effect.fn("SchemaAST.evaluate")(function* <A>(
  ast: SchemaAST.AST,
  algebra: SchemaASTFAlgebra<A>,
) {
  const schemaAST = yield* pipe(
    decodeSchemaASTF({ _tag: ast._tag, ast }),
    Effect.orDie,
  )

  return pipe(
    Match.value(schemaAST.ast),
    Match.tagsExhaustive(algebra),
  )
})
