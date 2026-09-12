import { Effect, Schema, pipe } from "effect"

export const NextCursorSchema = Schema.NullOr(Schema.String)

const CursorStateSchema = Schema.Record(Schema.String, Schema.Unknown)

export type Page<Value> = Readonly<{
  items: ReadonlyArray<Value>
  nextCursor: string | null
}>

const schema = <Item extends Schema.Constraint>(item: Item) => Schema.Struct({
  items: Schema.Array(item),
  nextCursor: NextCursorSchema,
})

const cursor = <const Scope extends string, After extends Schema.Constraint>(scope: Scope, after: After) => {
  const CursorEnvelopeSchema = Schema.Struct({
    scope: Schema.Literal(scope),
    filter: CursorStateSchema,
    range: CursorStateSchema,
    after,
  }).annotate({ parseOptions: { onExcessProperty: "error" } })

  const CursorJsonSchema = pipe(
    Schema.fromJsonString(Schema.Json),
    Schema.decodeTo(CursorEnvelopeSchema),
  )

  const parse = Schema.decodeUnknownEffect(CursorJsonSchema)
  const encode = Schema.encodeUnknownEffect(CursorJsonSchema)

  const render = Effect.fn("Page.renderCursor")(function* (
    state: Omit<typeof CursorEnvelopeSchema.Type, "scope">,
  ) {
    return yield* encode({ scope, ...state })
  })

  return Object.freeze({ parse, render })
}

export const Page = { schema, cursor }
