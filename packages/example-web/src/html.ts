import { Array, Equivalence, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"

const sameBoolean = Equivalence.strictEqual<boolean>()
const sameString = Equivalence.strictEqual<string>()


export const notice = <Message>(
  h: HtmlBuilder<Message>,
  kind: "info" | "error" | "success",
  text: string,
) => {
  const className = h.Class(`notice notice-${kind}`)
  const role = h.Role("status")
  return h.p([className, role], [text])
}

export const field = <Message>(
  h: HtmlBuilder<Message>,
  options: Readonly<{
    id: string
    label: string
    children: Html
    error?: string
  }>,
) => {
  const className = h.Class("field")
  const htmlFor = h.For(options.id)
  const labelClass = h.Class("field-label")
  const caption = h.span([labelClass], [options.label])
  const control = options.error === undefined
    ? options.children
    : h.div([], [options.children, h.p([h.Class("field-error")], [options.error])])
  return h.label([className, htmlFor], [caption, control])
}

export const textInput = <Message>(
  h: HtmlBuilder<Message>,
  options: Readonly<{
    id: string
    value: string
    onInput: (value: string) => Message
    type: string
    placeholder: string
    autocomplete: string
  }>,
) => {
  const id = h.Id(options.id)
  const className = h.Class("input")
  const type = h.Type(options.type)
  const value = h.Value(options.value)
  const onInput = h.OnInput(options.onInput)
  const placeholder = h.Placeholder(options.placeholder)
  const autocomplete = h.Autocomplete(options.autocomplete)
  return h.input([id, className, type, value, onInput, placeholder, autocomplete])
}

export const selectInput = <Message>(
  h: HtmlBuilder<Message>,
  options: Readonly<{
    id: string
    value: string
    onChange: (value: string) => Message
    choices: ReadonlyArray<Readonly<{ value: string; label: string }>>
  }>,
) => {
  const id = h.Id(options.id)
  const className = h.Class("input")
  const onChange = h.OnChange(options.onChange)
  const optionView = (choice: Readonly<{ value: string; label: string }>) => {
    const value = h.Value(choice.value)
    const selected = sameString(choice.value, options.value) ? [h.Selected(true)] : []
    return h.option(Array.appendAll([value], selected), [choice.label])
  }
  const optionsView = Array.map(options.choices, optionView)
  return h.select([id, className, onChange], optionsView)
}

export const textareaInput = <Message>(
  h: HtmlBuilder<Message>,
  options: Readonly<{
    id: string
    value: string
    onInput: (value: string) => Message
    rows: number
  }>,
) => {
  const id = h.Id(options.id)
  const className = h.Class("input")
  const value = h.Value(options.value)
  const onInput = h.OnInput(options.onInput)
  const rows = h.Rows(options.rows)
  return h.textarea([id, className, value, onInput, rows])
}

export const primaryButton = <Message>(
  h: HtmlBuilder<Message>,
  options: Readonly<{
    label: string
    message: Option.Option<Message>
    type: "button" | "submit"
    disabled: boolean
  }>,
) => {
  const className = h.Class("button button-primary")
  const type = h.Type(options.type)
  const disabled = sameBoolean(options.disabled, true) ? [h.Disabled(true)] : []
  const click = Option.match(options.message, {
    onNone: () => [],
    onSome: (message) => [h.OnClick(message)],
  })
  const attributes = Array.appendAll([className, type], Array.appendAll(disabled, click))
  return h.button(attributes, [options.label])
}

export const quietButton = <Message>(
  h: HtmlBuilder<Message>,
  options: Readonly<{
    label: string
    message: Message
    disabled: boolean
  }>,
) => {
  const className = h.Class("button button-quiet")
  const type = h.Type("button")
  const click = h.OnClick(options.message)
  const disabled = sameBoolean(options.disabled, true) ? [h.Disabled(true)] : []
  const attributes = Array.appendAll([className, type, click], disabled)
  return h.button(attributes, [options.label])
}

export const dataTable = <Message, Row>(
  h: HtmlBuilder<Message>,
  options: Readonly<{
    caption: string
    columns: ReadonlyArray<string>
    rows: ReadonlyArray<Row>
    cells: (row: Row) => ReadonlyArray<Html | string>
    key: (row: Row) => string
  }>,
) => {
  const className = h.Class("table")
  const caption = h.caption([], [options.caption])
  const headerCell = (column: string) => h.th([], [column])
  const header = h.thead([], [h.tr([], Array.map(options.columns, headerCell))])
  const emptyClass = h.Class("empty")
  const emptySpan = h.Colspan(options.columns.length)
  const empty = h.tr([], [h.td([emptySpan, emptyClass], ["No rows yet."])])
  const rowView = (row: Row) => {
    const key = h.Key(options.key(row))
    const cells = Array.map(options.cells(row), (cell) => h.td([], [cell]))
    return h.tr([key], cells)
  }
  const bodyRows = options.rows.length === 0 ? [empty] : Array.map(options.rows, rowView)
  const body = h.tbody([], bodyRows)
  return h.table([className], [caption, header, body])
}

export const shell = <Message>(
  h: HtmlBuilder<Message>,
  options: Readonly<{
    title: string
    lede: string
    notice: Readonly<{ kind: "info" | "error" | "success"; text: string }> | null
    session: Html | null
  }> & { children: ReadonlyArray<Html> },
) => {
  const shellClass = h.Class("shell")
  const mastheadClass = h.Class("masthead")
  const identityClass = h.Class("identity")
  const eyebrowClass = h.Class("eyebrow")
  const ledeClass = h.Class("lede")
  const eyebrow = h.p([eyebrowClass], ["Effect Domains"])
  const heading = h.h1([], [options.title])
  const lede = h.p([ledeClass], [options.lede])
  const identity = h.div([identityClass], [eyebrow, heading, lede])
  const session = options.session
  const sessionView = session === null ? h.empty : session
  const header = h.header([mastheadClass], [identity, sessionView])
  const banner = options.notice === null ? h.empty : notice(h, options.notice.kind, options.notice.text)
  const mainClass = h.Class("workspace")
  const main = h.main([mainClass], options.children)
  return h.div([shellClass], [header, banner, main])
}

