type PageState<Row> = Readonly<{ items: ReadonlyArray<Row>; nextCursor: string | null }>

const empty = <Row>(): PageState<Row> => ({ items: [], nextCursor: null })

const receive = <Row>(current: PageState<Row>, page: PageState<Row>, append: boolean): PageState<Row> =>
  append ? { items: [...current.items, ...page.items], nextCursor: page.nextCursor } : page

const input = (cursor: string | null): Readonly<Partial<{ cursor: string }>> =>
  cursor === null ? {} : { cursor }

export const Page = { empty, receive, input }
