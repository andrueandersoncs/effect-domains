import { Array, Effect, Predicate, Schema, pipe } from "effect"

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

const UnknownPageSchema = schema(Schema.Unknown)

const CursorInputSchema = Schema.Struct({
  cursor: Schema.optionalKey(Schema.String),
})

// SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
const empty = <Value>() => UnknownPageSchema.make({
  items: [],
  nextCursor: null,
}) as Page<Value>

const receive = <Value>(current: Page<Value>, incoming: Page<Value>, append: boolean) => {
  if (!append) return incoming

  const items = Array.appendAll(current.items, incoming.items)

  // SAFETY: The asserted type matches because this path constructs or validates the value from the corresponding declaration.
  return UnknownPageSchema.make({ items, nextCursor: incoming.nextCursor }) as Page<Value>
}

const input = (nextCursor: string | null) => Predicate.isNull(nextCursor)
  ? CursorInputSchema.make({})
  : CursorInputSchema.make({ cursor: nextCursor })

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

export const Page = { schema, cursor, empty, receive, input }
