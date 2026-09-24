import { Array, Clock, Data, DateTime, Effect, Equivalence, Option, Random, Record, Schema, Struct, pipe } from "effect"
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

const byteAt = (bytes: ReadonlyArray<number>, index: number) => pipe(bytes, Array.get(index), Option.getOrThrow)

const hexadecimalByte = (byte: number) => byte.toString(16).padStart(2, "0")

const uuidV7 = Effect.fn("Creation.uuidV7")(function* () {
  const byteIndexes = Array.range(0, 9)
  const values = yield* Effect.forEach(byteIndexes, () => Random.nextIntBetween(0, 255))
  const timestamp = (yield* Clock.currentTimeMillis).toString(16).padStart(12, "0")
  const timestampHigh = timestamp.substring(0, 8)
  const timestampLow = timestamp.substring(8, 12)
  const firstByte = byteAt(values, 0)
  const randomAHigh = firstByte & 0x0f
  const randomAByte = byteAt(values, 1)
  const randomALow = hexadecimalByte(randomAByte)
  const variantSource = byteAt(values, 2)
  const variantByte = (variantSource & 0x3f) | 0x80
  const variant = hexadecimalByte(variantByte)
  const fourthByte = byteAt(values, 3)
  const fourth = hexadecimalByte(fourthByte)
  const randomBBytes = Array.drop(values, 3)
  const hexadecimalRandomBBytes = Array.map(randomBBytes, hexadecimalByte)
  const randomB = Array.join(hexadecimalRandomBBytes, "")

  return `${timestampHigh}-${timestampLow}-7${randomAHigh.toString(16)}${randomALow}-${variant}${fourth}-${randomB.substring(2)}`
})

type ReadValue = (input: StructValue, subject: StructValue) => Effect.Effect<unknown>


export const CreationInspectionSchema = Schema.Struct({
  defaults: Schema.Unknown,
  generated: Schema.Unknown,
  fromSubject: Schema.Record(Schema.String, Schema.String),
})

export interface CreationInspection extends Schema.Schema.Type<typeof CreationInspectionSchema> {}

const compile = Effect.fn("Creation.compile")(function* <D, E>(
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
  const isUnknownField = (name: string) => !Record.has(fields, name)
  const unknownImplicitIdentifier = Option.filter(implicitIdentifier, isUnknownField)

  if (Option.isSome(unknownImplicitIdentifier)) {
    const failure = definitionFailure(`declares unknown implicit identifier field ${unknownImplicitIdentifier.value}`)

    return yield* Effect.fail(failure)
  }

  yield* Effect.forEach(names, (name) => {
    if (!Record.has(fields, name)) {
      const failure = definitionFailure(`declares unknown create field ${name}`)

      return Effect.fail(failure)
    }

    if (Option.contains(implicitIdentifier, name)) {
      const failure = definitionFailure(`explicitly configures implicit identifier field ${name}`)

      return Effect.fail(failure)
    }

    const defaulted = Record.has(defaults, name)
    const generatedField = Record.has(generated, name)
    const subjectBound = Record.has(bindings, name)
    const occurrences = Number(defaulted) + Number(generatedField) + Number(subjectBound)

    if (!Equivalence.strictEqual<number>()(occurrences, 1)) {
      const failure = definitionFailure(`multiply configures create field ${name}`)

      return Effect.fail(failure)
    }

    return Effect.void
  }, { discard: true })

  const defaultSources = Record.map(defaults, (value) => Source.Default({ value }))

  const generations: Readonly<Record<string, "uuidV7" | "now" | "one">> = Option.match(implicitIdentifier, {
    onNone: () => generated,
    onSome: (name) => Record.set(generated, name, "uuidV7" as const),
  })

  const generatedSources = Record.map(generations, (token) => Source.Generated({ token }))
  const subjectSources = Record.map(bindings, ({ field }) => Source.Subject({ field }))
  const sources = new Data.Class({ ...defaultSources, ...generatedSources, ...subjectSources })

  type CompiledRead = (input: StructValue, subject: StructValue) => Effect.Effect<unknown, E>

  const plan = Record.map(fields, (schema, name) => {
    const source = sources[name] ?? Source.Input()

    const readInput = (fallback: unknown): ReadValue => (input) => {
      const supplied = Record.has(input, name)
      const value = supplied ? input[name] : fallback

      return Effect.succeed(value)
    }

    const protectedRead = (
      label: string,
      evaluate: ReadValue,
    ): CompiledRead =>
      (input, subject) => {
        if (Record.has(input, name)) {
          const failure = inputFailure(`create input must not provide ${label} field ${name}`)

          return Effect.fail(failure)
        }

        return evaluate(input, subject)
      }

    const compiled: { readonly inputSchema: Schema.Constraint; readonly read: CompiledRead } = Source.$match(source, {
      Input: () => ({ inputSchema: schema, read: readInput(undefined) }),
      Default: ({ value }) => ({
        inputSchema: Schema.optionalKey(schema),
        read: readInput(value),
      }),
      Subject: ({ field }) => {
        const evaluate: ReadValue = (_input, subject) => Effect.succeed(subject[field])

        return { inputSchema: ForbiddenFieldSchema, read: protectedRead("subject-bound", evaluate) }
      },
      Generated: ({ token }) => {
        const evaluate = Effect.fn("Creation.generated")(function* () {
          if (isGeneration(token, "one")) return 1

          return yield* (isGeneration(token, "uuidV7") ? uuidV7() : DateTime.now)
        })

        return { inputSchema: ForbiddenFieldSchema, read: protectedRead("generated", evaluate) }
      },
    })

    return compiled
  })

  const materialize = Effect.fn("Creation.materialize")(function* (input: StructValue, subject: StructValue) {
    const entries = Record.toEntries(plan)

    const materializeField = Effect.fn("Creation.materializeField")(function* ([name, field]) {
      const value = yield* field.read(input, subject)

      return [name, value] as const
    })

    const values = yield* Effect.forEach(entries, materializeField)

    return Record.fromEntries(values)
  })

  const inputFields = Record.map(plan, Struct.get("inputSchema"))
  const fromSubject = Record.map(bindings, ({ field }) => `subject.${field}`)
  const inspection = CreationInspectionSchema.make({ defaults, generated: generations, fromSubject })

  return new Data.Class({ inputFields, materialize, inspection })
})

export const Creation = { compile }
