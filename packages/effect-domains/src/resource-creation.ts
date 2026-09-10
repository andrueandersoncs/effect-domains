import { Data, Effect, Equivalence, Function, Match, Record, Schema, pipe } from "effect"
import { Value } from "./value.ts"

/** Creation is a closed choice because input shape and value assembly must agree. */
type Source = Data.TaggedEnum<{
  Input: {}
  Default: { readonly value: unknown }
  Generated: { readonly token: "uuidV7" | "now" }
  Subject: { readonly field: string }
}>

const Source = Data.taggedEnum<Source>()
type CreationField = Readonly<{ schema: Schema.Constraint; source: Source }>
const ForbiddenFieldSchema = Schema.optionalKey(Schema.Never)
const isGeneration = Equivalence.strictEqual<"uuidV7" | "now">()

const compile = (
  fields: Schema.Struct.Fields,
  defaults: Readonly<Record<string, unknown>>,
  generated: Readonly<Record<string, "uuidV7" | "now">>,
  bindings: Readonly<Record<string, { readonly field: string }>>,
) => {
  const defaultSources = Record.map(defaults, (value) => Source.Default({ value }))
  const generatedSources = Record.map(generated, (token) => Source.Generated({ token }))
  const subjectSources = Record.map(bindings, ({ field }) => Source.Subject({ field }))
  const sources: Readonly<Record<string, Source>> = new Data.Class({ ...defaultSources, ...generatedSources, ...subjectSources })
  const input = Source.Input()
  return Record.map(fields, (schema, name): CreationField => new Data.Class({ schema, source: sources[name] ?? input }))
}

const inputField = (field: CreationField) => pipe(Match.value(field.source), Match.tagsExhaustive({
  Input: Function.constant(field.schema),
  Default: () => Schema.optionalKey(field.schema),
  Generated: Function.constant(ForbiddenFieldSchema),
  Subject: Function.constant(ForbiddenFieldSchema),
}))

const inputFields = (plan: Readonly<Record<string, CreationField>>) => Record.map(plan, inputField)

const materialize = Effect.fn("Creation.materialize")(function* <E>(
  plan: Readonly<Record<string, CreationField>>,
  input: Readonly<Record<string, unknown>>,
  subject: Readonly<Record<string, unknown>>,
  failure: (reason: string) => E,
) {
  const entries = Record.toEntries(plan)

  const values = yield* Effect.forEach(entries, Effect.fn("Creation.field")(function* ([name, field]) {
    const generated = Source.$is("Generated")(field.source)
    const bound = Source.$is("Subject")(field.source)
    const protectedField = generated || bound
    const supplied = Record.has(input, name)
    const override = protectedField && supplied
    if (override) return yield* pipe(failure(`create input must not provide ${generated ? "generated" : "subject-bound"} field ${name}`), Effect.fail)

    const value = yield* pipe(Match.value(field.source), Match.tagsExhaustive({
      Input: () => Effect.succeed(input[name]),
      Default: ({ value }) => Effect.succeed(supplied ? input[name] : value),
      Subject: ({ field }) => Effect.succeed(subject[field]),
      Generated: Effect.fn("Creation.generate")(function* ({ token }) {
        const values = yield* Value
        return isGeneration(token, "uuidV7") ? yield* values.uuidV7() : yield* values.now()
      }),
    }))

    return [name, value] as const
  }))

  return Record.fromEntries(values)
})

export const Creation = { compile, inputFields, materialize }
