import { expect, it } from "@effect/vitest"
import { Array, Data, Effect, Equivalence, Function, Match, Option, Schema, SchemaAST, Struct, pipe } from "effect"
import { SchemaField, type ScalarF } from "../packages/effect-domains/src/schema-field.ts"
import { Authorization } from "effect-domains/authorization"
import { Table } from "effect-domains/table"

const Numbers = Data.taggedEnum<ScalarF<number>>()
const increment = (value: number) => value + 1
const double = (value: number) => value * 2
const both = Function.flow(increment, double)

it.effect("scalar layer mapping preserves evidence and obeys identity and composition", () => Effect.sync(() => {
  const ast = SchemaAST.toType(Schema.String.ast)

  const layers = [
    Numbers.Leaf({ ast }), Numbers.Unsupported({ ast }),
    Numbers.Encoding({ ast, value: 2 }), Numbers.Suspend({ ast, value: 2 }),
    Numbers.Collection({ ast, value: 2 }), Numbers.Union({ ast, members: [2, 3] }),
  ]

  Array.forEach(layers, (layer) => {
    const unchanged = SchemaField.map(layer, Function.identity<number>)
    const incremented = SchemaField.map(layer, increment)
    const composed = SchemaField.map(incremented, double)
    const fused = SchemaField.map(layer, both)
    expect(unchanged).toEqual(layer)
    expect(composed).toEqual(fused)
    expect(composed.ast).toBe(ast)
  })
}))

const renderLayer = (layer: ScalarF<string>) => pipe(Match.value(layer), Match.tagsExhaustive({
  Leaf: ({ ast }) => ast._tag,
  Unsupported: Function.constant("Unsupported"),
  Encoding: ({ value }) => `Encoding(${value})`,
  Suspend: ({ value }) => `Suspend(${value})`,
  Collection: ({ value }) => `Collection(${value})`,
  Union: ({ members }) => pipe(members, Array.join(","), (children) => `Union(${children})`),
}))

const renderCanonical = SchemaField.fold("canonical", renderLayer)
const renderStorage = SchemaField.fold("storage", renderLayer)

it.effect("scalar folds retain encoding boundaries, homogeneous collections, and path-local cycles", () => Effect.sync(() => {
  const encoded = renderStorage(Schema.NumberFromString.ast)
  const canonical = pipe(Schema.NumberFromString.ast, SchemaAST.toType, renderCanonical)
  const stringsSchema = Schema.Array(Schema.String)
  const pairSchema = Schema.Tuple([Schema.String, Schema.String])
  const recursiveSchema: Schema.Codec<never> = Schema.suspend(() => recursiveSchema)
  const sharedSchema = Schema.suspend(() => Schema.String)
  const repeatedSchema = Schema.Union([sharedSchema, sharedSchema])
  expect(encoded).toBe("Encoding(String)")
  expect(canonical).toBe("Number")

  const descriptions = [
    renderCanonical(stringsSchema.ast), renderStorage(stringsSchema.ast), renderCanonical(pairSchema.ast),
    renderStorage(recursiveSchema.ast), renderCanonical(recursiveSchema.ast), renderCanonical(repeatedSchema.ast),
  ]

  expect(descriptions).toEqual([
    "Collection(String)", "Unsupported", "Unsupported", "Suspend(Unsupported)", "Suspend(Unsupported)",
    "Union(Suspend(String),Suspend(String))",
  ])
}))

it.effect("storage and policy algebras keep their different scalar acceptance rules", () => Effect.sync(() => {
  const NumericSchema = Schema.Struct({ amount: Schema.Number })
  const ClaimsSchema = Schema.Struct({ amount: Schema.Int, roles: Schema.Array(Schema.String) })
  interface Claims extends Schema.Schema.Type<typeof ClaimsSchema> {}
  const p = Authorization.for({ resource: NumericSchema, subject: ClaimsSchema })
  const broadNumber = p.eq(p.row.amount, p.subject.amount)
  const table = Table.make({ name: "broad_numbers", schema: NumericSchema })
  expect(table.fields).toMatchObject([{ name: "id" }, { name: "amount", scalar: "number" }])
  expect(() => p.policy({ scope: broadNumber, allow: { read: broadNumber } })).toThrow()
  const role = p.includes(p.subject.roles, "reader")
  const allowed = expect(() => p.policy({ scope: role, allow: { read: role } }))
  allowed.not.toThrow()
}))

it.effect("native table snapshots copy relation and check containers", () => Effect.sync(() => {
  const ChoiceSchema = Schema.Struct({ choice: Schema.Literals(["a", "b"]) })
  interface Choice extends Schema.Schema.Type<typeof ChoiceSchema> {}
  const fields = ["choice"] as const
  const referencedTable = Table.make({ name: "choice_targets", schema: ChoiceSchema })
  const references = Table.reference(referencedTable, fields)

  const relations = new Data.Class({
    unique: [{ name: "choice_unique", fields }],
    indexes: [{ name: "choice_index", fields }],
    foreignKeys: [{ name: "choice_foreign", fields, references }],
  })

  const table = Table.make({ name: "choices", schema: ChoiceSchema, relations })
  const first = Table.snapshot(table)
  const second = Table.snapshot(table)
  const originals = [relations, table.relations, first.relations, second.relations]
  const uniqueFieldsOf = (value: typeof originals[number]) => pipe(value?.unique ?? [], Array.head, Option.map(Struct.get("fields")), Option.getOrThrow)
  const uniqueFields = Array.map(originals, uniqueFieldsOf)
  const isolated = Array.dedupeWith(uniqueFields, Equivalence.strictEqual<unknown>())
  expect(isolated.length).toBe(4)
  const tableExpectation = expect(first)
  tableExpectation.not.toBe(second)
  expect(first).toEqual(second)
  const firstField = pipe(first.fields, Array.last, Option.getOrThrow)
  const secondField = pipe(second.fields, Array.last, Option.getOrThrow)
  const firstCheck = pipe(firstField.checks, Array.head, Option.getOrThrow)
  const secondCheck = pipe(secondField.checks, Array.head, Option.getOrThrow)
  const checkExpectation = expect(firstCheck)
  checkExpectation.not.toBe(secondCheck)
  expect(firstCheck).toEqual(secondCheck)
}))
