import {
  Array,
  HashSet,
  Match,
  Predicate,
  Schema,
  SchemaAST,
  Struct,
  flow,
  pipe,
} from "effect"

const declareSchemaAST = <A extends SchemaAST.AST>(
  isVariant: Predicate.Refinement<SchemaAST.AST, A>,
) => Schema.declare(Predicate.compose(SchemaAST.isAST, isVariant))

const SchemaASTVariantSchemas = {
  Declaration: declareSchemaAST(SchemaAST.isDeclaration),
  Null: declareSchemaAST(SchemaAST.isNull),
  Undefined: declareSchemaAST(SchemaAST.isUndefined),
  Void: declareSchemaAST(SchemaAST.isVoid),
  Never: declareSchemaAST(SchemaAST.isNever),
  Unknown: declareSchemaAST(SchemaAST.isUnknown),
  Any: declareSchemaAST(SchemaAST.isAny),
  String: declareSchemaAST(SchemaAST.isString),
  Number: declareSchemaAST(SchemaAST.isNumber),
  Boolean: declareSchemaAST(SchemaAST.isBoolean),
  BigInt: declareSchemaAST(SchemaAST.isBigInt),
  Symbol: declareSchemaAST(SchemaAST.isSymbol),
  Literal: declareSchemaAST(SchemaAST.isLiteral),
  UniqueSymbol: declareSchemaAST(SchemaAST.isUniqueSymbol),
  ObjectKeyword: declareSchemaAST(SchemaAST.isObjectKeyword),
  Enum: declareSchemaAST(SchemaAST.isEnum),
  TemplateLiteral: declareSchemaAST(SchemaAST.isTemplateLiteral),
  Arrays: declareSchemaAST(SchemaAST.isArrays),
  Objects: declareSchemaAST(SchemaAST.isObjects),
  Union: declareSchemaAST(SchemaAST.isUnion),
  Suspend: declareSchemaAST(SchemaAST.isSuspend),
} satisfies {
  readonly [Tag in SchemaAST.AST["_tag"]]: Schema.Schema<
    Extract<SchemaAST.AST, { readonly _tag: Tag }>
  >
}

const RecursiveResultsSchema = Schema.Array(Schema.Any)

const SchemaASTFCases = {
  Declaration: {
    ast: SchemaASTVariantSchemas.Declaration,
    typeParameters: RecursiveResultsSchema,
  },
  Null: { ast: SchemaASTVariantSchemas.Null },
  Undefined: { ast: SchemaASTVariantSchemas.Undefined },
  Void: { ast: SchemaASTVariantSchemas.Void },
  Never: { ast: SchemaASTVariantSchemas.Never },
  Unknown: { ast: SchemaASTVariantSchemas.Unknown },
  Any: { ast: SchemaASTVariantSchemas.Any },
  String: { ast: SchemaASTVariantSchemas.String },
  Number: { ast: SchemaASTVariantSchemas.Number },
  Boolean: { ast: SchemaASTVariantSchemas.Boolean },
  BigInt: { ast: SchemaASTVariantSchemas.BigInt },
  Symbol: { ast: SchemaASTVariantSchemas.Symbol },
  Literal: { ast: SchemaASTVariantSchemas.Literal },
  UniqueSymbol: { ast: SchemaASTVariantSchemas.UniqueSymbol },
  ObjectKeyword: { ast: SchemaASTVariantSchemas.ObjectKeyword },
  Enum: { ast: SchemaASTVariantSchemas.Enum },
  TemplateLiteral: {
    ast: SchemaASTVariantSchemas.TemplateLiteral,
    parts: RecursiveResultsSchema,
  },
  Arrays: {
    ast: SchemaASTVariantSchemas.Arrays,
    elements: RecursiveResultsSchema,
    rest: RecursiveResultsSchema,
  },
  Objects: {
    ast: SchemaASTVariantSchemas.Objects,
    propertySignatures: RecursiveResultsSchema,
    indexSignatureParameters: RecursiveResultsSchema,
    indexSignatureTypes: RecursiveResultsSchema,
  },
  Union: {
    ast: SchemaASTVariantSchemas.Union,
    types: RecursiveResultsSchema,
  },
  Suspend: {
    ast: SchemaASTVariantSchemas.Suspend,
    thunk: Schema.declare(Predicate.isFunction),
  },
} satisfies Record<SchemaAST.AST["_tag"], Schema.Struct.Fields>

export const SchemaASTFSchema = Schema.TaggedUnion(SchemaASTFCases)

export type SchemaASTF<A> =
  | Exclude<
      Schema.Schema.Type<typeof SchemaASTFSchema>,
      | Extract<
          Schema.Schema.Type<typeof SchemaASTFSchema>,
          { readonly _tag: "Declaration" }
        >
      | Extract<
          Schema.Schema.Type<typeof SchemaASTFSchema>,
          { readonly _tag: "TemplateLiteral" }
        >
      | Extract<
          Schema.Schema.Type<typeof SchemaASTFSchema>,
          { readonly _tag: "Arrays" }
        >
      | Extract<
          Schema.Schema.Type<typeof SchemaASTFSchema>,
          { readonly _tag: "Objects" }
        >
      | Extract<
          Schema.Schema.Type<typeof SchemaASTFSchema>,
          { readonly _tag: "Union" }
        >
      | Extract<
          Schema.Schema.Type<typeof SchemaASTFSchema>,
          { readonly _tag: "Suspend" }
        >
    >
  | (Omit<
      Extract<
        Schema.Schema.Type<typeof SchemaASTFSchema>,
        { readonly _tag: "Declaration" }
      >,
      "typeParameters"
    > & { readonly typeParameters: ReadonlyArray<A> })
  | (Omit<
      Extract<
        Schema.Schema.Type<typeof SchemaASTFSchema>,
        { readonly _tag: "TemplateLiteral" }
      >,
      "parts"
    > & { readonly parts: ReadonlyArray<A> })
  | (Omit<
      Extract<
        Schema.Schema.Type<typeof SchemaASTFSchema>,
        { readonly _tag: "Arrays" }
      >,
      "elements" | "rest"
    > & {
      readonly elements: ReadonlyArray<A>
      readonly rest: ReadonlyArray<A>
    })
  | (Omit<
      Extract<
        Schema.Schema.Type<typeof SchemaASTFSchema>,
        { readonly _tag: "Objects" }
      >,
      "propertySignatures" | "indexSignatureParameters" | "indexSignatureTypes"
    > & {
      readonly propertySignatures: ReadonlyArray<A>
      readonly indexSignatureParameters: ReadonlyArray<A>
      readonly indexSignatureTypes: ReadonlyArray<A>
    })
  | (Omit<
      Extract<
        Schema.Schema.Type<typeof SchemaASTFSchema>,
        { readonly _tag: "Union" }
      >,
      "types"
    > & { readonly types: ReadonlyArray<A> })
  | (Omit<
      Extract<
        Schema.Schema.Type<typeof SchemaASTFSchema>,
        { readonly _tag: "Suspend" }
      >,
      "thunk"
    > & { readonly thunk: () => A })

export type SchemaASTFAlgebra<A> = (ast: SchemaASTF<A>) => A

const retainAST = <A extends SchemaAST.AST>(ast: A) =>
  Struct.assign(ast, { ast })

const project = <A>(
  ast: SchemaAST.AST,
  recur: (ast: SchemaAST.AST) => A,
): SchemaASTF<A> =>
  pipe(
    Match.value(ast),
    Match.tagsExhaustive({
      Declaration: (declaration) =>
        Struct.assign(retainAST(declaration), {
          typeParameters: Array.map(declaration.typeParameters, recur),
        }),
      Null: retainAST,
      Undefined: retainAST,
      Void: retainAST,
      Never: retainAST,
      Unknown: retainAST,
      Any: retainAST,
      String: retainAST,
      Number: retainAST,
      Boolean: retainAST,
      BigInt: retainAST,
      Symbol: retainAST,
      Literal: retainAST,
      UniqueSymbol: retainAST,
      ObjectKeyword: retainAST,
      Enum: retainAST,
      TemplateLiteral: (templateLiteral) =>
        Struct.assign(retainAST(templateLiteral), {
          parts: Array.map(templateLiteral.parts, recur),
        }),
      Arrays: (arrays) =>
        Struct.assign(retainAST(arrays), {
          elements: Array.map(arrays.elements, recur),
          rest: Array.map(arrays.rest, recur),
        }),
      Objects: (objects) =>
        Struct.assign(retainAST(objects), {
          propertySignatures: Array.map(
            objects.propertySignatures,
            flow(Struct.get("type"), recur),
          ),
          indexSignatureParameters: Array.map(
            objects.indexSignatures,
            flow(Struct.get("parameter"), recur),
          ),
          indexSignatureTypes: Array.map(
            objects.indexSignatures,
            flow(Struct.get("type"), recur),
          ),
        }),
      Union: (union) =>
        Struct.assign(retainAST(union), {
          types: Array.map(union.types, recur),
        }),
      Suspend: (suspend) =>
        Struct.assign(retainAST(suspend), {
          thunk: flow(suspend.thunk, recur),
        }),
    }),
  )

export const evaluate = <A>(
  ast: SchemaAST.AST,
  algebra: SchemaASTFAlgebra<A>,
  onSuspendCycle: (ast: SchemaAST.Suspend) => A,
): A => {
  const go = (
    ast: SchemaAST.AST,
    suspends: HashSet.HashSet<SchemaAST.Suspend>,
  ): A => {
    const isSuspendCycle = SchemaAST.isSuspend(ast) && HashSet.has(suspends, ast)

    if (isSuspendCycle) {
      return onSuspendCycle(ast)
    }

    const nextSuspends = SchemaAST.isSuspend(ast)
      ? HashSet.add(suspends, ast)
      : suspends

    return algebra(project(ast, (child) => go(child, nextSuspends)))
  }

  return go(ast, HashSet.empty())
}
