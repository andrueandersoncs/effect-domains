import { Array, Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import type { Document } from "foldkit/html"
import { type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import {
  dataTable,
  field,
  primaryButton,
  quietButton,
  selectInput,
  shell,
  textInput,
} from "@effect-domains/example-web/html"
import { rpcCall } from "@effect-domains/example-web/rpc"
import { ExpenseSchema } from "../domain.ts"

const ExpenseRowSchema = Schema.Struct({
  id: Schema.String,
  date: ExpenseSchema.fields.date,
  merchant: ExpenseSchema.fields.merchant,
  category: ExpenseSchema.fields.category,
  amountMinor: ExpenseSchema.fields.amountMinor,
  currency: ExpenseSchema.fields.currency,
})

const ExpenseTotalsSchema = Schema.Array(Schema.Struct({
  category: ExpenseSchema.fields.category,
  currency: ExpenseSchema.fields.currency,
  totalMinor: ExpenseSchema.fields.amountMinor,
}))

const categories = ["meals", "travel", "software", "supplies", "other"] as const
const formCategoryChoices = Array.map(categories, (category) => ({ value: category, label: category }))
const filterCategoryChoices = [{ value: "", label: "All categories" }, ...formCategoryChoices]
const today = new Date().toISOString().slice(0, 10)

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
  busy: Schema.Boolean,
  notice: Schema.NullOr(Schema.Struct({
    kind: Schema.Literals(["info", "error", "success"]),
    text: Schema.String,
  })),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedFrom: { value: Schema.String },
  ChangedThrough: { value: Schema.String },
  ChangedFilterCategory: { value: Schema.String },
  ChangedDate: { value: Schema.String },
  ChangedMerchant: { value: Schema.String },
  ChangedCategory: { value: Schema.String },
  ChangedAmountMinor: { value: Schema.String },
  ChangedCurrency: { value: Schema.String },
  ClickedReload: {},
  ClickedSave: {},
  ClickedNew: {},
  ClickedSelect: { id: Schema.String },
  ClickedRemove: { id: Schema.String },
  SucceededList: { expenses: Schema.Array(ExpenseRowSchema) },
  SucceededTotals: { totals: ExpenseTotalsSchema },
  SucceededGet: { expense: ExpenseRowSchema },
  SucceededSave: { expense: ExpenseRowSchema, created: Schema.Boolean },
  SucceededRemove: { id: Schema.String },
  Failed: { error: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message>

const emptyForm = {
  date: today,
  merchant: "",
  category: "meals",
  amountMinor: "",
  currency: "USD",
  selectedId: null as string | null,
}

const queryPayload = (from: string, through: string, filterCategory: string) => ({
  from,
  through,
  ...(filterCategory === "" ? {} : { category: filterCategory }),
  limit: 50,
})

export const ListExpenses = Command.define("ListExpenses", {
  args: {
    from: Schema.String,
    through: Schema.String,
    filterCategory: Schema.String,
  },
  messages: [Message.SucceededList, Message.Failed],
  execute: ({ from, through, filterCategory }) =>
    pipe(
      rpcCall({
        tag: "expenses.query",
        payload: queryPayload(from, through, filterCategory),
        token: null,
        success: Schema.Array(ExpenseRowSchema),
      }),
      Effect.match({
        onSuccess: (expenses) => Message.SucceededList({ expenses }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const LoadTotals = Command.define("LoadTotals", {
  args: {
    from: Schema.String,
    through: Schema.String,
    filterCategory: Schema.String,
  },
  messages: [Message.SucceededTotals, Message.Failed],
  execute: ({ from, through, filterCategory }) =>
    pipe(
      rpcCall({
        tag: "expenses.totals",
        payload: queryPayload(from, through, filterCategory),
        token: null,
        success: ExpenseTotalsSchema,
      }),
      Effect.match({
        onSuccess: (totals) => Message.SucceededTotals({ totals }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const GetExpense = Command.define("GetExpense", {
  args: { id: Schema.String },
  messages: [Message.SucceededGet, Message.Failed],
  execute: ({ id }) =>
    pipe(
      rpcCall({
        tag: "expenses.get",
        payload: { id },
        token: null,
        success: ExpenseRowSchema,
      }),
      Effect.match({
        onSuccess: (expense) => Message.SucceededGet({ expense }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const SaveExpense = Command.define("SaveExpense", {
  args: {
    selectedId: Schema.NullOr(Schema.String),
    date: Schema.String,
    merchant: Schema.String,
    category: Schema.String,
    amountMinor: Schema.String,
    currency: Schema.String,
  },
  messages: [Message.SucceededSave, Message.Failed],
  execute: (args) => {
    const expense = {
      date: args.date,
      merchant: args.merchant.trim(),
      category: args.category,
      amountMinor: Number(args.amountMinor),
      currency: args.currency.trim().toUpperCase(),
    }
    const created = args.selectedId === null
    return pipe(
      rpcCall({
        tag: created ? "expenses.record" : "expenses.update",
        payload: created ? expense : { id: args.selectedId, ...expense },
        token: null,
        success: ExpenseRowSchema,
      }),
      Effect.match({
        onSuccess: (saved) => Message.SucceededSave({ expense: saved, created }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    )
  },
})

export const RemoveExpense = Command.define("RemoveExpense", {
  args: { id: Schema.String },
  messages: [Message.SucceededRemove, Message.Failed],
  execute: ({ id }) =>
    pipe(
      rpcCall({
        tag: "expenses.remove",
        payload: { id },
        token: null,
        success: ExpenseRowSchema,
      }),
      Effect.match({
        onSuccess: () => Message.SucceededRemove({ id }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

const reload = (model: Model) => [
  ListExpenses({
    from: model.from,
    through: model.through,
    filterCategory: model.filterCategory,
  }),
  LoadTotals({
    from: model.from,
    through: model.through,
    filterCategory: model.filterCategory,
  }),
]

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedFrom: ({ value }) => ({ model: evo(model, { from: () => value }) }),
    ChangedThrough: ({ value }) => ({ model: evo(model, { through: () => value }) }),
    ChangedFilterCategory: ({ value }) => ({ model: evo(model, { filterCategory: () => value }) }),
    ChangedDate: ({ value }) => ({ model: evo(model, { date: () => value }) }),
    ChangedMerchant: ({ value }) => ({ model: evo(model, { merchant: () => value }) }),
    ChangedCategory: ({ value }) => ({ model: evo(model, { category: () => value }) }),
    ChangedAmountMinor: ({ value }) => ({ model: evo(model, { amountMinor: () => value }) }),
    ChangedCurrency: ({ value }) => ({ model: evo(model, { currency: () => value }) }),
    ClickedReload: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: reload(model),
    }),
    ClickedSave: () => {
      const amountMinor = Number(model.amountMinor)
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) {
        return {
          model: evo(model, {
            notice: () => ({ kind: "error" as const, text: "Amount must be a positive whole number of minor units." }),
          }),
        }
      }
      return {
        model: evo(model, { busy: () => true, notice: () => null }),
        commands: [SaveExpense({
          selectedId: model.selectedId,
          date: model.date,
          merchant: model.merchant,
          category: model.category,
          amountMinor: model.amountMinor,
          currency: model.currency,
        })],
      }
    },
    ClickedNew: () => ({
      model: evo(model, {
        date: () => emptyForm.date,
        merchant: () => emptyForm.merchant,
        category: () => emptyForm.category,
        amountMinor: () => emptyForm.amountMinor,
        currency: () => emptyForm.currency,
        selectedId: () => emptyForm.selectedId,
        notice: () => null,
      }),
    }),
    ClickedSelect: ({ id }) => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [GetExpense({ id })],
    }),
    ClickedRemove: ({ id }) => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [RemoveExpense({ id })],
    }),
    SucceededList: ({ expenses }) => ({
      model: evo(model, { expenses: () => expenses, busy: () => false }),
    }),
    SucceededTotals: ({ totals }) => ({ model: evo(model, { totals: () => totals }) }),
    SucceededGet: ({ expense }) => ({
      model: evo(model, {
        selectedId: () => expense.id,
        date: () => expense.date,
        merchant: () => expense.merchant,
        category: () => expense.category,
        amountMinor: () => String(expense.amountMinor),
        currency: () => expense.currency,
        busy: () => false,
      }),
    }),
    SucceededSave: ({ expense, created }) => ({
      model: evo(model, {
        selectedId: () => expense.id,
        date: () => expense.date,
        merchant: () => expense.merchant,
        category: () => expense.category,
        amountMinor: () => String(expense.amountMinor),
        currency: () => expense.currency,
        busy: () => true,
        notice: () => ({ kind: "success" as const, text: created ? "Expense recorded." : "Expense updated." }),
      }),
      commands: reload(model),
    }),
    SucceededRemove: ({ id }) => ({
      model: evo(model, {
        date: () => model.selectedId === id ? emptyForm.date : model.date,
        merchant: () => model.selectedId === id ? emptyForm.merchant : model.merchant,
        category: () => model.selectedId === id ? emptyForm.category : model.category,
        amountMinor: () => model.selectedId === id ? emptyForm.amountMinor : model.amountMinor,
        currency: () => model.selectedId === id ? emptyForm.currency : model.currency,
        busy: () => true,
        notice: () => ({ kind: "success" as const, text: "Expense removed." }),
        selectedId: () => model.selectedId === id ? null : model.selectedId,
      }),
      commands: reload(model),
    }),
    Failed: ({ error }) => ({
      model: evo(model, {
        busy: () => false,
        notice: () => ({ kind: "error" as const, text: error }),
      }),
    }),
  })

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    expenses: [],
    totals: [],
    from: "2026-01-01",
    through: "2026-12-31",
    filterCategory: "",
    ...emptyForm,
    busy: true,
    notice: null,
  },
  commands: [
    ListExpenses({ from: "2026-01-01", through: "2026-12-31", filterCategory: "" }),
    LoadTotals({ from: "2026-01-01", through: "2026-12-31", filterCategory: "" }),
  ],
})


export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Expense ledger",
  body: shell(h, {
    title: "Expense ledger",
    lede: "Record business expenses and review category totals for a date range.",
    notice: model.notice,
    session: null,
    children: [
      h.div(
        [h.Class("split")],
        [
          h.section(
            [h.Class("panel stack")],
            [
              h.div(
                [h.Class("actions")],
                [
                  field(h, {
                    id: "from",
                    label: "From",
                    children: textInput(h, { id: "from", type: "date", value: model.from, onInput: (value) => Message.ChangedFrom({ value }), placeholder: "", autocomplete: "off" }),
                  }),
                  field(h, {
                    id: "through",
                    label: "Through",
                    children: textInput(h, { id: "through", type: "date", value: model.through, onInput: (value) => Message.ChangedThrough({ value }), placeholder: "", autocomplete: "off" }),
                  }),
                  field(h, {
                    id: "filter-category",
                    label: "Category",
                    children: selectInput(h, { id: "filter-category", value: model.filterCategory, onChange: (value) => Message.ChangedFilterCategory({ value }), choices: filterCategoryChoices }),
                  }),
                  primaryButton(h, { label: model.busy ? "Loading…" : "Refresh", message: Option.some(Message.ClickedReload()), type: "button", disabled: model.busy }),
                ],
              ),
              dataTable(h, {
                caption: "Expenses",
                columns: ["Date", "Merchant", "Category", "Amount (minor)", "Currency", ""],
                rows: model.expenses,
                key: (expense) => expense.id,
                cells: (expense) => [
                  expense.date,
                  expense.merchant,
                  expense.category,
                  String(expense.amountMinor),
                  expense.currency,
                  h.div(
                    [h.Class("row-actions")],
                    [
                      quietButton(h, { label: "Edit", message: Message.ClickedSelect({ id: expense.id }), disabled: model.busy }),
                      quietButton(h, { label: "Remove", message: Message.ClickedRemove({ id: expense.id }), disabled: model.busy }),
                    ],
                  ),
                ],
              }),
              dataTable(h, {
                caption: "Totals by category and currency",
                columns: ["Category", "Currency", "Total (minor)"],
                rows: model.totals,
                key: (total) => `${total.category}-${total.currency}`,
                cells: (total) => [total.category, total.currency, String(total.totalMinor)],
              }),
            ],
          ),
          h.section(
            [h.Class("panel")],
            [
              h.form(
                [h.Class("stack"), h.OnSubmit(Message.ClickedSave())],
                [
                  h.h2([], [model.selectedId === null ? "Record expense" : "Edit expense"]),
                  field(h, {
                    id: "date",
                    label: "Date",
                    children: textInput(h, { id: "date", type: "date", value: model.date, onInput: (value) => Message.ChangedDate({ value }), placeholder: "", autocomplete: "off" }),
                  }),
                  field(h, {
                    id: "merchant",
                    label: "Merchant",
                    children: textInput(h, { id: "merchant", type: "text", value: model.merchant, onInput: (value) => Message.ChangedMerchant({ value }), placeholder: "", autocomplete: "off" }),
                  }),
                  field(h, {
                    id: "category",
                    label: "Category",
                    children: selectInput(h, { id: "category", value: model.category, onChange: (value) => Message.ChangedCategory({ value }), choices: formCategoryChoices }),
                  }),
                  field(h, {
                    id: "amount-minor",
                    label: "Amount (minor units)",
                    children: textInput(h, { id: "amount-minor", type: "number", value: model.amountMinor, onInput: (value) => Message.ChangedAmountMinor({ value }), placeholder: "", autocomplete: "off" }),
                  }),
                  field(h, {
                    id: "currency",
                    label: "Currency",
                    children: textInput(h, { id: "currency", type: "text", value: model.currency, onInput: (value) => Message.ChangedCurrency({ value }), placeholder: "USD", autocomplete: "off" }),
                  }),
                  h.div(
                    [h.Class("actions")],
                    [
                      primaryButton(h, { label: model.selectedId === null ? "Record expense" : "Save changes", message: Option.none(), type: "submit", disabled: model.busy }),
                      quietButton(h, { label: "Clear", message: Message.ClickedNew(), disabled: false }),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  }),
})
