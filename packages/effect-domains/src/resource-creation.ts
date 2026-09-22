import { Array, Data, Effect, Equivalence, Option, Record, Schema, Struct, pipe } from "effect"
import { Value } from "./value.ts"
import type { StructValue } from "./domain.ts"



/** Compile sources together because input acceptance and runtime values must agree. */
type Source = Data.TaggedEnum<{
  Input: {}
  Default: { readonly value: unknown }
  Generated: { readonly token: "uuidV7" | "now" | "one" }
  Subject: { readonly field: string }
}>

const Source = Data.taggedEnum<Source>()
const ForbiddenFieldSchema = Schema.optionalKey(Schema.Never)
const isGeneration = Equivalence.strictEqual<"uuidV7" | "now" | "one">()

type ReadValue = (input: StructValue, subject: StructValue) => Effect.Effect<unknown, never, Value>

class FieldCompilation extends Data.Class<{ readonly inputSchema: Schema.Constraint; readonly evaluate: ReadValue }> {}

const equals = Equivalence.strictEqual<unknown>()

export const CreationInspectionSchema = Schema.Struct({
  defaults: Schema.Unknown,
  generated: Schema.Unknown,
  fromSubject: Schema.Record(Schema.String, Schema.String),
})

export interface CreationInspection extends Schema.Schema.Type<typeof CreationInspectionSchema> {}

const compile = function* <D, E>(
  fields: Schema.Struct.Fields,
  defaults: StructValue,
  generated: Readonly<Record<string, "uuidV7" | "now" | "one">>,
  bindings: Readonly<Record<string, { readonly field: string }>>,
  definitionFailure: (reason: string) => D,
  inputFailure: (reason: string) => E,
  implicitIdentifier: Option.Option<string>,
) {
  const declarations = [defaults, generated, bindings]
  const names = Array.flatMap(declarations, Record.keys)

  yield* Effect.forEach(names, (name) => {
    const implicit = Option.contains(implicitIdentifier, name)
    const present = Record.has(fields, name)
    const canonical = !implicit
    const known = present && canonical
    const occurrences = Array.filter(declarations, (declaration) => Record.has(declaration, name))
    const exclusive = equals(occurrences.length, 1)
    const valid = known && exclusive

    return valid ? Effect.void : pipe(definitionFailure(`declares unknown or multiply configured create field ${name}`), Effect.fail)
  }, { discard: true })

  const defaultSources = Record.map(defaults, (value) => Source.Default({ value }))

  const generations = Option.match(implicitIdentifier, {
    onNone: () => generated,
    onSome: (name) => Record.set(generated, name, "uuidV7" as const),
  })

  const generatedSources = Record.map(generations, (token) => Source.Generated({ token }))
  const subjectSources = Record.map(bindings, ({ field }) => Source.Subject({ field }))
  const sources = new Data.Class({ ...defaultSources, ...generatedSources, ...subjectSources })

  const plan = Record.map(fields, (schema, name) => {
    const source = sources[name] ?? Source.Input()

    const readInput = (fallback: unknown): ReadValue => (input) => {
      const supplied = Record.has(input, name)

      return Effect.succeed(supplied ? input[name] : fallback)
    }

    const compiled = Source.$match(source, {
      Input: () => {
        const evaluate = readInput(undefined)

        return new FieldCompilation({ inputSchema: schema, evaluate })
      },
      Default: ({ value }) => {
        const inputSchema = Schema.optionalKey(schema)
        const evaluate = readInput(value)

        return new FieldCompilation({ inputSchema, evaluate })
      },
      Subject: ({ field }) => {
        const evaluate: ReadValue = (_input, subject) => Effect.succeed(subject[field])

        return new FieldCompilation({ inputSchema: ForbiddenFieldSchema, evaluate })
      },
      Generated: ({ token }) => {
        const evaluate = Effect.fn("Creation.generated")(function* () {
          if (isGeneration(token, "one")) return 1

          const values = yield* Value

          return yield* (isGeneration(token, "uuidV7") ? values.uuidV7() : values.now())
        })

        return new FieldCompilation({ inputSchema: ForbiddenFieldSchema, evaluate })
      },
    })

    const read = (input: StructValue, subject: StructValue): Effect.Effect<unknown, E, Value> => {
      const supplied = Record.has(input, name)
      const protectedField = equals(compiled.inputSchema, ForbiddenFieldSchema)
      const label = Source.$is("Generated")(source) ? "generated" : "subject-bound"
      const override = protectedField && supplied

      return override ? pipe(inputFailure(`create input must not provide ${label} field ${name}`), Effect.fail) : compiled.evaluate(input, subject)
    }

    return new Data.Class({ inputSchema: compiled.inputSchema, read })
  })

  const materialize = (input: StructValue, subject: StructValue) => pipe(
    Record.toEntries(plan),
    Effect.forEach(([name, field]) => pipe(field.read(input, subject), Effect.map((value) => [name, value] as const))),
    Effect.map(Record.fromEntries),
  )

  const inputFields = Record.map(plan, Struct.get("inputSchema"))
  const fromSubject = Record.map(bindings, ({ field }) => `subject.${field}`)
  const inspection = CreationInspectionSchema.make({ defaults, generated: generations, fromSubject })

  return new Data.Class({ inputFields, materialize, inspection })
}

export const Creation = { compile: Effect.fn("Creation.compile")(compile) }
