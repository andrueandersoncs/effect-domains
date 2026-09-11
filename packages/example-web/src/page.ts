import { Schema } from "effect"

type PageState<Row> = Readonly<{ items: ReadonlyArray<Row>; nextCursor: string | null }>

const schema = <S extends Schema.Constraint>(itemSchema: S) => Schema.Struct({
  items: Schema.Array(Schema.toType(itemSchema)),
  nextCursor: Schema.NullOr(Schema.String),
})

const empty = <Row>(): PageState<Row> => ({ items: [], nextCursor: null })

const receive = <Row>(current: PageState<Row>, page: PageState<Row>, append: boolean): PageState<Row> =>
  append ? { items: [...current.items, ...page.items], nextCursor: page.nextCursor } : page

const input = (cursor: string | null): Readonly<Partial<{ cursor: string }>> =>
  cursor === null ? {} : { cursor }

export const Page = { schema, empty, receive, input }
