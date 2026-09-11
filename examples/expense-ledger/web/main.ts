import { Array, Context, Effect, Layer, Option, Schema, pipe } from "effect"
import { RpcClient, RpcClientError } from "effect/unstable/rpc"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import { dataTable, field, primaryButton, quietButton, selectInput, shell, textInput } from "@effect-domains/example-web/html"
import { Form } from "@effect-domains/example-web/form"
import { browserProtocol, formatRpcError } from "@effect-domains/example-web/rpc"
import { Requests, RequestStateSchema, RequestTokenSchema } from "@effect-domains/example-web/requests"
import { ExpenseQueryInputSchema, ExpenseSchema, ExpenseTotalSchema } from "../domain.ts"
import { ExpensesResource } from "../resources.ts"
import { ExpenseLedgerOperations } from "../sqlite.ts"

const ExpenseRowSchema = ExpensesResource.table.rowSchema
const ExpenseTotalsSchema = Schema.Array(ExpenseTotalSchema)
const categories = ["meals", "travel", "software", "supplies", "other"] as const
const formCategoryChoices = Array.map(categories, (category) => ({ value: category, label: category }))
const filterCategoryChoices = [{ value: "", label: "All categories" }, ...formCategoryChoices]
const today = new Date().toISOString().slice(0, 10)

const ExpenseLedgerWebRpcs = ExpensesResource.group.merge(
  ExpenseLedgerOperations.group,
)

export class WebClient extends Context.Service<WebClient, RpcClient.FromGroup<typeof ExpenseLedgerWebRpcs, RpcClientError.RpcClientError>>()("expense-ledger/WebClient") {
  static readonly layer = pipe(Layer.effect(WebClient, RpcClient.make(ExpenseLedgerWebRpcs)), Layer.provide(browserProtocol))
}

export const Model = Schema.Struct({
  expenses: Schema.Array(ExpenseRowSchema),
  totals: ExpenseTotalsSchema,
  from: Schema.String,
  through: Schema.String,
  filterCategory: Schema.String,
  date: Schema.String,
  merchant: Schema.String,
  category: Schema.String,
  amountMinor: Schema.String,
  currency: Schema.String,
  selectedId: Schema.NullOr(Schema.String),
  requests: RequestStateSchema,
  notice: Schema.NullOr(Schema.Struct({ kind: Schema.Literals(["info", "error", "success"]), text: Schema.String })),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedFrom: { value: Schema.String }, ChangedThrough: { value: Schema.String }, ChangedFilterCategory: { value: Schema.String },
  ChangedDate: { value: Schema.String }, ChangedMerchant: { value: Schema.String }, ChangedCategory: { value: Schema.String }, ChangedAmountMinor: { value: Schema.String }, ChangedCurrency: { value: Schema.String },
  ClickedReload: {}, ClickedSave: {}, ClickedNew: {}, ClickedSelect: { id: Schema.String }, ClickedRemove: { id: Schema.String },
  SucceededList: { request: RequestTokenSchema, expenses: Schema.Array(ExpenseRowSchema) },
  SucceededTotals: { request: RequestTokenSchema, totals: ExpenseTotalsSchema },
  SucceededGet: { request: RequestTokenSchema, expense: ExpenseRowSchema },
  SucceededSave: { request: RequestTokenSchema, expense: ExpenseRowSchema, created: Schema.Boolean },
  SucceededRemove: { request: RequestTokenSchema, id: Schema.String },
  Failed: { request: RequestTokenSchema, error: Schema.String },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient>

const emptyForm = { date: today, merchant: "", category: "meals", amountMinor: "", currency: "USD", selectedId: null as string | null }
const queryPayload = (from: string, through: string, filterCategory: string) => Schema.decodeUnknownEffect(ExpenseQueryInputSchema)({ from, through, ...(filterCategory === "" ? {} : { category: filterCategory }), limit: 50 })
const requestEffect = <A, E, Success extends Message>(request: typeof RequestTokenSchema.Type, effect: Effect.Effect<A, E, WebClient>, success: (value: A) => Success) => pipe(
  effect,
  Effect.match({ onSuccess: success, onFailure: (error) => Message.Failed({ request, error: formatRpcError(error) }) }),
)

export const ListExpenses = Command.define("ListExpenses", {
  args: { request: RequestTokenSchema, from: Schema.String, through: Schema.String, filterCategory: Schema.String }, messages: [Message.SucceededList, Message.Failed],
  execute: ({ request, from, through, filterCategory }) => requestEffect(request, Effect.gen(function*() {
    const client = yield* WebClient
    const query = yield* queryPayload(from, through, filterCategory)
    const page = yield* client["expenses.list"]({
      range: { date: { from: query.from, to: query.through } },
      ...(query.category === undefined ? {} : { filter: { category: query.category } }),
      limit: 50,
    })
    return page.items
  }), (expenses) => Message.SucceededList({ request, expenses })),
})
export const LoadTotals = Command.define("LoadTotals", {
  args: { request: RequestTokenSchema, from: Schema.String, through: Schema.String, filterCategory: Schema.String }, messages: [Message.SucceededTotals, Message.Failed],
  execute: ({ request, from, through, filterCategory }) => requestEffect(request, Effect.gen(function*() { const client = yield* WebClient; return yield* client["expenses.totals"](yield* queryPayload(from, through, filterCategory)) }), (totals) => Message.SucceededTotals({ request, totals })),
})
export const GetExpense = Command.define("GetExpense", {
  args: { request: RequestTokenSchema, id: Schema.String }, messages: [Message.SucceededGet, Message.Failed],
  execute: ({ request, id }) => requestEffect(request, pipe(WebClient, Effect.flatMap((client) => client["expenses.get"]({ id }))), (expense) => Message.SucceededGet({ request, expense })),
})
export const SaveExpense = Command.define("SaveExpense", {
  args: { request: RequestTokenSchema, selectedId: Schema.NullOr(Schema.String), date: Schema.String, merchant: Schema.String, category: Schema.String, amountMinor: Schema.String, currency: Schema.String }, messages: [Message.SucceededSave, Message.Failed],
  execute: (args) => requestEffect(args.request, Effect.gen(function*() {
    const expense = yield* Schema.decodeUnknownEffect(ExpenseSchema)({ date: args.date, merchant: args.merchant.trim(), category: args.category, amountMinor: yield* Schema.decodeUnknownEffect(Form.integer(ExpenseSchema.fields.amountMinor))(args.amountMinor), currency: args.currency.trim().toUpperCase() })
    const client = yield* WebClient
    const created = args.selectedId === null
    const saved = yield* (created ? client["expenses.record"](expense) : client["expenses.update"]({ id: args.selectedId, ...expense }))
    return { saved, created }
  }), ({ saved, created }) => Message.SucceededSave({ request: args.request, expense: saved, created })),
})
export const RemoveExpense = Command.define("RemoveExpense", {
  args: { request: RequestTokenSchema, id: Schema.String }, messages: [Message.SucceededRemove, Message.Failed],
  execute: ({ request, id }) => requestEffect(request, pipe(WebClient, Effect.flatMap((client) => client["expenses.remove"]({ id }))), () => Message.SucceededRemove({ request, id })),
})

const reload = (model: Model) => {
  const listed = Requests.start(model.requests, "list")
  const totaled = Requests.start(listed.state, "totals")
  return { state: totaled.state, commands: [ListExpenses({ request: listed.request, from: model.from, through: model.through, filterCategory: model.filterCategory }), LoadTotals({ request: totaled.request, from: model.from, through: model.through, filterCategory: model.filterCategory })] }
}
const pending = (model: Model, key?: string) => Requests.pending(model.requests, key)
const clearQuery = (model: Model) => evo(model, {
  expenses: () => [],
  totals: () => [],
  requests: (current) => Requests.invalidate(Requests.invalidate(current, "list"), "totals"),
  notice: () => null,
})

export const update = (model: Model, message: Message) => Message.match<UpdateReturn>(message, {
  ChangedFrom: ({ value }) => ({ model: evo(clearQuery(model), { from: () => value }) }), ChangedThrough: ({ value }) => ({ model: evo(clearQuery(model), { through: () => value }) }), ChangedFilterCategory: ({ value }) => ({ model: evo(clearQuery(model), { filterCategory: () => value }) }),
  ChangedDate: ({ value }) => ({ model: evo(model, { date: () => value }) }), ChangedMerchant: ({ value }) => ({ model: evo(model, { merchant: () => value }) }), ChangedCategory: ({ value }) => ({ model: evo(model, { category: () => value }) }), ChangedAmountMinor: ({ value }) => ({ model: evo(model, { amountMinor: () => value }) }), ChangedCurrency: ({ value }) => ({ model: evo(model, { currency: () => value }) }),
  ClickedReload: () => { const next = reload(model); return { model: evo(model, { requests: () => next.state, notice: () => null }), commands: next.commands } },
  ClickedSave: () => { const started = Requests.start(model.requests, "save"); return { model: evo(model, { requests: () => started.state, notice: () => null }), commands: [SaveExpense({ request: started.request, selectedId: model.selectedId, date: model.date, merchant: model.merchant, category: model.category, amountMinor: model.amountMinor, currency: model.currency })] } },
  ClickedNew: () => ({ model: evo(model, { date: () => emptyForm.date, merchant: () => emptyForm.merchant, category: () => emptyForm.category, amountMinor: () => emptyForm.amountMinor, currency: () => emptyForm.currency, selectedId: () => null, notice: () => null }) }),
  ClickedSelect: ({ id }) => { const started = Requests.start(model.requests, "get"); return { model: evo(model, { requests: () => started.state, notice: () => null }), commands: [GetExpense({ request: started.request, id })] } },
  ClickedRemove: ({ id }) => { const started = Requests.start(model.requests, "remove"); return { model: evo(model, { requests: () => started.state, notice: () => null }), commands: [RemoveExpense({ request: started.request, id })] } },
  SucceededList: ({ request, expenses }) => Requests.accepts(model.requests, request) ? { model: evo(model, { expenses: () => expenses, requests: (current) => Requests.succeed(current, request) }) } : { model },
  SucceededTotals: ({ request, totals }) => Requests.accepts(model.requests, request) ? { model: evo(model, { totals: () => totals, requests: (current) => Requests.succeed(current, request) }) } : { model },
  SucceededGet: ({ request, expense }) => Requests.accepts(model.requests, request) ? { model: evo(model, { selectedId: () => expense.id, date: () => expense.date, merchant: () => expense.merchant, category: () => expense.category, amountMinor: () => String(expense.amountMinor), currency: () => expense.currency, requests: (current) => Requests.succeed(current, request) }) } : { model },
  SucceededSave: ({ request, expense, created }) => { if (!Requests.accepts(model.requests, request)) return { model }; const settled = evo(model, { selectedId: () => expense.id, date: () => expense.date, merchant: () => expense.merchant, category: () => expense.category, amountMinor: () => String(expense.amountMinor), currency: () => expense.currency, requests: (current) => Requests.succeed(current, request), notice: () => ({ kind: "success" as const, text: created ? "Expense recorded." : "Expense updated." }) }); const next = reload(settled); return { model: evo(settled, { requests: () => next.state }), commands: next.commands } },
  SucceededRemove: ({ request, id }) => { if (!Requests.accepts(model.requests, request)) return { model }; const settled = evo(model, { selectedId: () => model.selectedId === id ? null : model.selectedId, requests: (current) => Requests.succeed(current, request), notice: () => ({ kind: "success" as const, text: "Expense removed." }) }); const next = reload(settled); return { model: evo(settled, { requests: () => next.state }), commands: next.commands } },
  Failed: ({ request, error }) => Requests.accepts(model.requests, request) ? { model: evo(model, { requests: (current) => Requests.fail(current, request, error), notice: () => ({ kind: "error" as const, text: error }) }) } : { model },
})

export const init: Runtime.ApplicationInit<Model, Message, void, WebClient> = () => { const model: Model = { expenses: [], totals: [], from: "2026-01-01", through: "2026-12-31", filterCategory: "", ...emptyForm, requests: Requests.empty(), notice: null }; const next = reload(model); return { model: evo(model, { requests: () => next.state }), commands: next.commands } }

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({ title: "Expense ledger", body: shell(h, { title: "Expense ledger", lede: "Record business expenses and review category totals for a date range.", notice: model.notice, session: null, children: [h.div([h.Class("split")], [
  h.section([h.Class("panel stack")], [h.div([h.Class("actions")], [
    field(h, { id: "from", label: "From", children: textInput(h, { id: "from", type: "date", value: model.from, onInput: (value) => Message.ChangedFrom({ value }), placeholder: "", autocomplete: "off" }) }),
    field(h, { id: "through", label: "Through", children: textInput(h, { id: "through", type: "date", value: model.through, onInput: (value) => Message.ChangedThrough({ value }), placeholder: "", autocomplete: "off" }) }),
    field(h, { id: "filter-category", label: "Category", children: selectInput(h, { id: "filter-category", value: model.filterCategory, onChange: (value) => Message.ChangedFilterCategory({ value }), choices: filterCategoryChoices }) }),
    primaryButton(h, { label: pending(model, "list") || pending(model, "totals") ? "Loading…" : "Refresh", message: Option.some(Message.ClickedReload()), type: "button", disabled: pending(model, "list") || pending(model, "totals") }),
  ]), dataTable(h, { caption: "Expenses", columns: ["Date", "Merchant", "Category", "Amount (minor)", "Currency", ""], rows: model.expenses, key: (expense) => expense.id, cells: (expense) => [expense.date, expense.merchant, expense.category, String(expense.amountMinor), expense.currency, h.div([h.Class("row-actions")], [quietButton(h, { label: "Edit", message: Message.ClickedSelect({ id: expense.id }), disabled: pending(model) }), quietButton(h, { label: "Remove", message: Message.ClickedRemove({ id: expense.id }), disabled: pending(model) })])] }),
  dataTable(h, { caption: "Totals by category and currency", columns: ["Category", "Currency", "Total (minor)"], rows: model.totals, key: (total) => `${total.category}-${total.currency}`, cells: (total) => [total.category, total.currency, String(total.totalMinor)] }),
  ]),
  h.section([h.Class("panel")], [h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSave())], [h.h2([], [model.selectedId === null ? "Record expense" : "Edit expense"]),
    field(h, { id: "date", label: "Date", children: textInput(h, { id: "date", type: "date", value: model.date, onInput: (value) => Message.ChangedDate({ value }), placeholder: "", autocomplete: "off" }) }), field(h, { id: "merchant", label: "Merchant", children: textInput(h, { id: "merchant", type: "text", value: model.merchant, onInput: (value) => Message.ChangedMerchant({ value }), placeholder: "", autocomplete: "off" }) }), field(h, { id: "category", label: "Category", children: selectInput(h, { id: "category", value: model.category, onChange: (value) => Message.ChangedCategory({ value }), choices: formCategoryChoices }) }), field(h, { id: "amount-minor", label: "Amount (minor units)", children: textInput(h, { id: "amount-minor", type: "number", value: model.amountMinor, onInput: (value) => Message.ChangedAmountMinor({ value }), placeholder: "", autocomplete: "off" }) }), field(h, { id: "currency", label: "Currency", children: textInput(h, { id: "currency", type: "text", value: model.currency, onInput: (value) => Message.ChangedCurrency({ value }), placeholder: "USD", autocomplete: "off" }) }), h.div([h.Class("actions")], [primaryButton(h, { label: model.selectedId === null ? "Record expense" : "Save changes", message: Option.none(), type: "submit", disabled: pending(model, "save") }), quietButton(h, { label: "Clear", message: Message.ClickedNew(), disabled: false })])
  ])]),
]) ] }) })
