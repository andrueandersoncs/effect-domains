import { Effect, Option, Schema, pipe } from "effect"
import { Command, Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
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
  textareaInput,
} from "@effect-domains/example-web/html"
import { rpcCall } from "@effect-domains/example-web/rpc"
import { RepairBoardRowSchema } from "../board.ts"
import { CustomerSchema, RepairJobSchema, RepairStatusSchema, TechnicianSchema } from "../domain.ts"

const CustomerPageSchema = Schema.Struct({ items: Schema.Array(CustomerSchema), nextCursor: Schema.NullOr(Schema.String) })
const TechnicianPageSchema = Schema.Struct({ items: Schema.Array(TechnicianSchema), nextCursor: Schema.NullOr(Schema.String) })
const RepairJobRowSchema = Schema.Struct({ id: Schema.String, ...RepairJobSchema.fields })
const statuses = ["queued", "repairing", "ready"] as const
const statusChoices = statuses.map((value) => ({ value, label: value }))
const filterChoices = [{ value: "", label: "All statuses" }, ...statusChoices]
const booleanChoices = [{ value: "false", label: "No" }, { value: "true", label: "Yes" }]

type Customer = typeof CustomerSchema.Type
type Technician = typeof TechnicianSchema.Type
type RepairBoardRow = typeof RepairBoardRowSchema.Type

export const Model = Schema.Struct({
  customers: Schema.Array(CustomerSchema),
  technicians: Schema.Array(TechnicianSchema),
  board: Schema.Array(RepairBoardRowSchema),
  customerCursor: Schema.NullOr(Schema.String),
  technicianCursor: Schema.NullOr(Schema.String),
  filterStatus: Schema.String,
  customerId: Schema.String,
  customerName: Schema.String,
  editingCustomerId: Schema.NullOr(Schema.String),
  technicianId: Schema.String,
  technicianName: Schema.String,
  technicianOnCall: Schema.Boolean,
  editingTechnicianId: Schema.NullOr(Schema.String),
  repairCustomerId: Schema.String,
  repairItem: Schema.String,
  repairFault: Schema.String,
  repairUrgent: Schema.Boolean,
  repairStatus: RepairStatusSchema,
  repairTechnicianId: Schema.String,
  pending: Schema.Int,
  notice: Schema.NullOr(Schema.Struct({ kind: Schema.Literals(["info", "error", "success"]), text: Schema.String })),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedFilterStatus: { value: Schema.String },
  ChangedCustomerId: { value: Schema.String },
  ChangedCustomerName: { value: Schema.String },
  ChangedTechnicianId: { value: Schema.String },
  ChangedTechnicianName: { value: Schema.String },
  ChangedTechnicianOnCall: { value: Schema.String },
  ChangedRepairCustomer: { value: Schema.String },
  ChangedRepairItem: { value: Schema.String },
  ChangedRepairFault: { value: Schema.String },
  ChangedRepairUrgent: { value: Schema.String },
  ChangedRepairStatus: { value: Schema.String },
  ChangedRepairTechnician: { value: Schema.String },
  ClickedReload: {},
  ClickedNextCustomers: {},
  ClickedNextTechnicians: {},
  ClickedSaveCustomer: {},
  ClickedEditCustomer: { id: Schema.String },
  ClickedClearCustomer: {},
  ClickedSaveTechnician: {},
  ClickedEditTechnician: { id: Schema.String },
  ClickedClearTechnician: {},
  ClickedCreateRepair: {},
  ChangedBoardStatus: { id: Schema.String, value: Schema.String },
  ChangedBoardTechnician: { id: Schema.String, value: Schema.String },
  SucceededCustomers: { items: Schema.Array(CustomerSchema), nextCursor: Schema.NullOr(Schema.String), append: Schema.Boolean },
  SucceededTechnicians: { items: Schema.Array(TechnicianSchema), nextCursor: Schema.NullOr(Schema.String), append: Schema.Boolean },
  SucceededBoard: { rows: Schema.Array(RepairBoardRowSchema) },
  SucceededCustomer: { customer: CustomerSchema, created: Schema.Boolean },
  SucceededTechnician: { technician: TechnicianSchema, created: Schema.Boolean },
  SucceededRepair: { repair: RepairJobRowSchema, created: Schema.Boolean },
  Failed: { error: Schema.String },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message>

export const LoadCustomers = Command.define("LoadCustomers", {
  args: { cursor: Schema.NullOr(Schema.String), append: Schema.Boolean },
  messages: [Message.SucceededCustomers, Message.Failed],
  execute: ({ cursor, append }) => pipe(rpcCall({
    tag: "customers.list", payload: { limit: 50, ...(cursor === null ? {} : { cursor }) }, token: null, success: CustomerPageSchema,
  }), Effect.match({
    onSuccess: (page) => Message.SucceededCustomers({ ...page, append }),
    onFailure: (error) => Message.Failed({ error: error.message }),
  })),
})

export const LoadTechnicians = Command.define("LoadTechnicians", {
  args: { cursor: Schema.NullOr(Schema.String), append: Schema.Boolean },
  messages: [Message.SucceededTechnicians, Message.Failed],
  execute: ({ cursor, append }) => pipe(rpcCall({
    tag: "technicians.list", payload: { limit: 50, ...(cursor === null ? {} : { cursor }) }, token: null, success: TechnicianPageSchema,
  }), Effect.match({
    onSuccess: (page) => Message.SucceededTechnicians({ ...page, append }),
    onFailure: (error) => Message.Failed({ error: error.message }),
  })),
})

export const LoadBoard = Command.define("LoadBoard", {
  args: { status: Schema.String },
  messages: [Message.SucceededBoard, Message.Failed],
  execute: ({ status }) => pipe(rpcCall({
    tag: "workshop.board", payload: { limit: 100, ...(status === "" ? {} : { status }) }, token: null, success: Schema.Array(RepairBoardRowSchema),
  }), Effect.match({
    onSuccess: (rows) => Message.SucceededBoard({ rows }),
    onFailure: (error) => Message.Failed({ error: error.message }),
  })),
})

export const SaveCustomer = Command.define("SaveCustomer", {
  args: { id: Schema.String, name: Schema.String, editingId: Schema.NullOr(Schema.String) },
  messages: [Message.SucceededCustomer, Message.Failed],
  execute: ({ id, name, editingId }) => {
    const creating = editingId === null
    return pipe(rpcCall({
      tag: creating ? "customers.create" : "customers.patch",
      payload: creating ? { id: id.trim(), name: name.trim() } : { key: editingId, changes: { name: name.trim() } },
      token: null,
      success: CustomerSchema,
    }), Effect.match({
      onSuccess: (customer) => Message.SucceededCustomer({ customer, created: creating }),
      onFailure: (error) => Message.Failed({ error: error.message }),
    }))
  },
})

export const SaveTechnician = Command.define("SaveTechnician", {
  args: { id: Schema.String, name: Schema.String, onCall: Schema.Boolean, editingId: Schema.NullOr(Schema.String) },
  messages: [Message.SucceededTechnician, Message.Failed],
  execute: ({ id, name, onCall, editingId }) => {
    const creating = editingId === null
    return pipe(rpcCall({
      tag: creating ? "technicians.create" : "technicians.patch",
      payload: creating ? { id: id.trim(), name: name.trim(), onCall } : { key: editingId, changes: { name: name.trim(), onCall } },
      token: null,
      success: TechnicianSchema,
    }), Effect.match({
      onSuccess: (technician) => Message.SucceededTechnician({ technician, created: creating }),
      onFailure: (error) => Message.Failed({ error: error.message }),
    }))
  },
})

export const SaveRepair = Command.define("SaveRepair", {
  args: { customerId: Schema.String, item: Schema.String, fault: Schema.String, urgent: Schema.Boolean, status: RepairStatusSchema, technicianId: Schema.String },
  messages: [Message.SucceededRepair, Message.Failed],
  execute: (args) => pipe(rpcCall({
    tag: "repair_jobs.create",
    payload: { ...args, customerId: args.customerId.trim(), item: args.item.trim(), fault: args.fault.trim(), technicianId: args.technicianId === "" ? null : args.technicianId },
    token: null,
    success: RepairJobRowSchema,
  }), Effect.match({
    onSuccess: (repair) => Message.SucceededRepair({ repair, created: true }),
    onFailure: (error) => Message.Failed({ error: error.message }),
  })),
})

export const PatchRepairStatus = Command.define("PatchRepairStatus", {
  args: { id: Schema.String, status: RepairStatusSchema },
  messages: [Message.SucceededRepair, Message.Failed],
  execute: ({ id, status }) => pipe(rpcCall({
    tag: "repair_jobs.patch", payload: { key: id, changes: { status } }, token: null, success: RepairJobRowSchema,
  }), Effect.match({
    onSuccess: (repair) => Message.SucceededRepair({ repair, created: false }),
    onFailure: (error) => Message.Failed({ error: error.message }),
  })),
})

export const PatchRepairTechnician = Command.define("PatchRepairTechnician", {
  args: { id: Schema.String, technicianId: Schema.NullOr(Schema.String) },
  messages: [Message.SucceededRepair, Message.Failed],
  execute: ({ id, technicianId }) => pipe(rpcCall({
    tag: "repair_jobs.patch", payload: { key: id, changes: { technicianId } }, token: null, success: RepairJobRowSchema,
  }), Effect.match({
    onSuccess: (repair) => Message.SucceededRepair({ repair, created: false }),
    onFailure: (error) => Message.Failed({ error: error.message }),
  })),
})

const refresh = (model: Model) => [
  LoadCustomers({ cursor: null, append: false }),
  LoadTechnicians({ cursor: null, append: false }),
  LoadBoard({ status: model.filterStatus }),
]
const ready = (pending: number) => Math.max(0, pending - 1)
const emptyCustomer = { customerId: "", customerName: "", editingCustomerId: null as string | null }
const emptyTechnician = { technicianId: "", technicianName: "", technicianOnCall: false, editingTechnicianId: null as string | null }
const emptyRepair = { repairCustomerId: "", repairItem: "", repairFault: "", repairUrgent: false, repairStatus: "queued" as const, repairTechnicianId: "" }
const valid = (value: string) => value.trim() !== ""

export const update = (model: Model, message: Message) => Message.match<UpdateReturn>(message, {
  ChangedFilterStatus: ({ value }) => ({ model: evo(model, { filterStatus: () => value }) }),
  ChangedCustomerId: ({ value }) => ({ model: evo(model, { customerId: () => value }) }),
  ChangedCustomerName: ({ value }) => ({ model: evo(model, { customerName: () => value }) }),
  ChangedTechnicianId: ({ value }) => ({ model: evo(model, { technicianId: () => value }) }),
  ChangedTechnicianName: ({ value }) => ({ model: evo(model, { technicianName: () => value }) }),
  ChangedTechnicianOnCall: ({ value }) => ({ model: evo(model, { technicianOnCall: () => value === "true" }) }),
  ChangedRepairCustomer: ({ value }) => ({ model: evo(model, { repairCustomerId: () => value }) }),
  ChangedRepairItem: ({ value }) => ({ model: evo(model, { repairItem: () => value }) }),
  ChangedRepairFault: ({ value }) => ({ model: evo(model, { repairFault: () => value }) }),
  ChangedRepairUrgent: ({ value }) => ({ model: evo(model, { repairUrgent: () => value === "true" }) }),
  ChangedRepairStatus: ({ value }) => ({ model: evo(model, { repairStatus: () => value as Model["repairStatus"] }) }),
  ChangedRepairTechnician: ({ value }) => ({ model: evo(model, { repairTechnicianId: () => value }) }),
  ClickedReload: () => ({ model: evo(model, { pending: () => 3, notice: () => null }), commands: refresh(model) }),
  ClickedNextCustomers: () => model.customerCursor === null ? { model } : ({ model: evo(model, { pending: () => 1 }), commands: [LoadCustomers({ cursor: model.customerCursor, append: true })] }),
  ClickedNextTechnicians: () => model.technicianCursor === null ? { model } : ({ model: evo(model, { pending: () => 1 }), commands: [LoadTechnicians({ cursor: model.technicianCursor, append: true })] }),
  ClickedSaveCustomer: () => {
    if (!valid(model.customerName) || (model.editingCustomerId === null && !valid(model.customerId))) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Customer ID and name are required." }) }) }
    return { model: evo(model, { pending: () => 1, notice: () => null }), commands: [SaveCustomer({ id: model.customerId, name: model.customerName, editingId: model.editingCustomerId })] }
  },
  ClickedEditCustomer: ({ id }) => {
    const customer = model.customers.find((candidate) => candidate.id === id)
    return customer === undefined ? { model } : { model: evo(model, { customerId: () => customer.id, customerName: () => customer.name, editingCustomerId: () => customer.id, notice: () => null }) }
  },
  ClickedClearCustomer: () => ({ model: evo(model, { customerId: () => "", customerName: () => "", editingCustomerId: () => null, notice: () => null }) }),
  ClickedSaveTechnician: () => {
    if (!valid(model.technicianName) || (model.editingTechnicianId === null && !valid(model.technicianId))) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Technician ID and name are required." }) }) }
    return { model: evo(model, { pending: () => 1, notice: () => null }), commands: [SaveTechnician({ id: model.technicianId, name: model.technicianName, onCall: model.technicianOnCall, editingId: model.editingTechnicianId })] }
  },
  ClickedEditTechnician: ({ id }) => {
    const technician = model.technicians.find((candidate) => candidate.id === id)
    return technician === undefined ? { model } : { model: evo(model, { technicianId: () => technician.id, technicianName: () => technician.name, technicianOnCall: () => technician.onCall, editingTechnicianId: () => technician.id, notice: () => null }) }
  },
  ClickedClearTechnician: () => ({ model: evo(model, { technicianId: () => "", technicianName: () => "", technicianOnCall: () => false, editingTechnicianId: () => null, notice: () => null }) }),
  ClickedCreateRepair: () => {
    if (!valid(model.repairCustomerId) || !valid(model.repairItem) || !valid(model.repairFault)) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Choose a customer and enter the item and fault." }) }) }
    return { model: evo(model, { pending: () => 1, notice: () => null }), commands: [SaveRepair({ customerId: model.repairCustomerId, item: model.repairItem, fault: model.repairFault, urgent: model.repairUrgent, status: model.repairStatus, technicianId: model.repairTechnicianId })] }
  },
  ChangedBoardStatus: ({ id, value }) => model.pending > 0 ? { model } : ({ model: evo(model, { pending: () => 1, notice: () => null }), commands: [PatchRepairStatus({ id, status: value as Model["repairStatus"] })] }),
  ChangedBoardTechnician: ({ id, value }) => model.pending > 0 ? { model } : ({ model: evo(model, { pending: () => 1, notice: () => null }), commands: [PatchRepairTechnician({ id, technicianId: value === "" ? null : value })] }),
  SucceededCustomers: ({ items, nextCursor, append }) => ({ model: evo(model, { customers: () => append ? [...model.customers, ...items] : items, customerCursor: () => nextCursor, pending: () => ready(model.pending) }) }),
  SucceededTechnicians: ({ items, nextCursor, append }) => ({ model: evo(model, { technicians: () => append ? [...model.technicians, ...items] : items, technicianCursor: () => nextCursor, pending: () => ready(model.pending) }) }),
  SucceededBoard: ({ rows }) => ({ model: evo(model, { board: () => rows, pending: () => ready(model.pending) }) }),
  SucceededCustomer: ({ created }) => ({ model: evo(model, { customerId: () => "", customerName: () => "", editingCustomerId: () => null, pending: () => 3, notice: () => ({ kind: "success" as const, text: created ? "Customer created." : "Customer updated." }) }), commands: refresh(model) }),
  SucceededTechnician: ({ created }) => ({ model: evo(model, { technicianId: () => "", technicianName: () => "", technicianOnCall: () => false, editingTechnicianId: () => null, pending: () => 3, notice: () => ({ kind: "success" as const, text: created ? "Technician created." : "Technician updated." }) }), commands: refresh(model) }),
  SucceededRepair: ({ created }) => ({ model: evo(model, { repairCustomerId: () => "", repairItem: () => "", repairFault: () => "", repairUrgent: () => false, repairStatus: () => "queued", repairTechnicianId: () => "", pending: () => 3, notice: () => ({ kind: "success" as const, text: created ? "Repair created." : "Repair updated." }) }), commands: refresh(model) }),
  Failed: ({ error }) => ({ model: evo(model, { pending: () => ready(model.pending), notice: () => ({ kind: "error" as const, text: error }) }) }),
})

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { customers: [], technicians: [], board: [], customerCursor: null, technicianCursor: null, filterStatus: "", ...emptyCustomer, ...emptyTechnician, ...emptyRepair, pending: 3, notice: null },
  commands: [LoadCustomers({ cursor: null, append: false }), LoadTechnicians({ cursor: null, append: false }), LoadBoard({ status: "" })],
})

const pageButton = (h: HtmlBuilder<Message>, label: string, message: Message, enabled: boolean) => quietButton(h, { label, message, disabled: !enabled })
const technicianChoices = (technicians: ReadonlyArray<Technician>) => [{ value: "", label: "Unassigned" }, ...technicians.map((technician) => ({ value: technician.id, label: `${technician.name} (${technician.id})` }))]
const customerChoices = (customers: ReadonlyArray<Customer>) => [{ value: "", label: "Choose a customer" }, ...customers.map((customer) => ({ value: customer.id, label: `${customer.name} (${customer.id})` }))]
const repairTechnicianChoices = (technicians: ReadonlyArray<Technician>, repair: RepairBoardRow) => {
  const choices = technicianChoices(technicians)
  const loaded = technicians.some((technician) => technician.id === repair.technicianId)
  return repair.technicianId === null || loaded ? choices : [
    ...choices,
    { value: repair.technicianId, label: `${repair.technicianName} (${repair.technicianId})` },
  ]
}
const onCall = (value: boolean | null) => value === null ? "—" : value ? "Yes" : "No"

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Repair workshop",
  body: shell(h, {
    title: "Repair workshop",
    lede: "Create customers, technicians, and repairs. The board is a joined projection and shows up to 100 matching repairs.",
    notice: model.notice,
    session: null,
    children: [
      h.section([h.Class("panel stack")], [
        h.div([h.Class("actions")], [
          field(h, { id: "board-status", label: "Board status", children: selectInput(h, { id: "board-status", value: model.filterStatus, onChange: (value) => Message.ChangedFilterStatus({ value }), choices: filterChoices }) }),
          primaryButton(h, { label: model.pending > 0 ? "Loading…" : "Reload", message: Option.some(Message.ClickedReload()), type: "button", disabled: model.pending > 0 }),
        ]),
        dataTable(h, {
          caption: "Repair board", columns: ["Customer", "Item", "Fault", "Urgent", "Status", "Technician", "On call"], rows: model.board, key: (repair) => repair.id,
          cells: (repair) => [
            `${repair.customerName} (${repair.customerId})`, repair.item, repair.fault, repair.urgent ? "Yes" : "No",
            field(h, { id: `repair-status-${repair.id}`, label: "Status", children: selectInput(h, { id: `repair-status-${repair.id}`, value: repair.status, onChange: (value) => Message.ChangedBoardStatus({ id: repair.id, value }), choices: statusChoices }) }),
            field(h, { id: `repair-technician-${repair.id}`, label: "Technician", children: selectInput(h, { id: `repair-technician-${repair.id}`, value: repair.technicianId ?? "", onChange: (value) => Message.ChangedBoardTechnician({ id: repair.id, value }), choices: repairTechnicianChoices(model.technicians, repair) }) }),
            onCall(repair.technicianOnCall),
          ],
        }),
      ]),
      h.div([h.Class("split")], [
        h.section([h.Class("panel stack")], [
          h.form([h.Class("stack"), h.OnSubmit(Message.ClickedCreateRepair())], [
            h.h2([], ["Create repair"]),
            field(h, { id: "repair-customer", label: "Customer", children: selectInput(h, { id: "repair-customer", value: model.repairCustomerId, onChange: (value) => Message.ChangedRepairCustomer({ value }), choices: customerChoices(model.customers) }) }),
            field(h, { id: "repair-item", label: "Item", children: textInput(h, { id: "repair-item", value: model.repairItem, onInput: (value) => Message.ChangedRepairItem({ value }), type: "text", placeholder: "Espresso machine", autocomplete: "off" }) }),
            field(h, { id: "repair-fault", label: "Fault", children: textareaInput(h, { id: "repair-fault", value: model.repairFault, onInput: (value) => Message.ChangedRepairFault({ value }), rows: 3 }) }),
            h.div([h.Class("actions")], [
              field(h, { id: "repair-urgent", label: "Urgent", children: selectInput(h, { id: "repair-urgent", value: String(model.repairUrgent), onChange: (value) => Message.ChangedRepairUrgent({ value }), choices: booleanChoices }) }),
              field(h, { id: "repair-new-status", label: "Status", children: selectInput(h, { id: "repair-new-status", value: model.repairStatus, onChange: (value) => Message.ChangedRepairStatus({ value }), choices: statusChoices }) }),
              field(h, { id: "repair-technician", label: "Technician", children: selectInput(h, { id: "repair-technician", value: model.repairTechnicianId, onChange: (value) => Message.ChangedRepairTechnician({ value }), choices: technicianChoices(model.technicians) }) }),
            ]),
            primaryButton(h, { label: "Create repair", message: Option.none(), type: "submit", disabled: model.pending > 0 }),
          ]),
        ]),
        h.section([h.Class("panel stack")], [
          h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSaveCustomer())], [
            h.h2([], [model.editingCustomerId === null ? "Create customer" : "Edit customer"]),
            model.editingCustomerId === null
              ? field(h, { id: "customer-id", label: "Customer ID", children: textInput(h, { id: "customer-id", value: model.customerId, onInput: (value) => Message.ChangedCustomerId({ value }), type: "text", placeholder: "customer-1", autocomplete: "off" }) })
              : h.p([], [`Customer ID: ${model.editingCustomerId}`]),
            field(h, { id: "customer-name", label: "Name", children: textInput(h, { id: "customer-name", value: model.customerName, onInput: (value) => Message.ChangedCustomerName({ value }), type: "text", placeholder: "Ada Customer", autocomplete: "off" }) }),
            h.div([h.Class("actions")], [primaryButton(h, { label: model.editingCustomerId === null ? "Create customer" : "Save customer", message: Option.none(), type: "submit", disabled: model.pending > 0 }), quietButton(h, { label: "Clear", message: Message.ClickedClearCustomer(), disabled: model.pending > 0 })]),
          ]),
          dataTable(h, { caption: "Customers loaded for selector", columns: ["ID", "Name", ""], rows: model.customers, key: (customer) => customer.id, cells: (customer) => [customer.id, customer.name, quietButton(h, { label: "Edit", message: Message.ClickedEditCustomer({ id: customer.id }), disabled: model.pending > 0 })] }),
          model.pending > 0 ? h.p([], ["Loading customer pages…"]) : model.customerCursor === null ? h.p([], ["All customer pages loaded."]) : pageButton(h, "Load next customers", Message.ClickedNextCustomers(), true),
          h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSaveTechnician())], [
            h.h2([], [model.editingTechnicianId === null ? "Create technician" : "Edit technician"]),
            model.editingTechnicianId === null
              ? field(h, { id: "technician-id", label: "Technician ID", children: textInput(h, { id: "technician-id", value: model.technicianId, onInput: (value) => Message.ChangedTechnicianId({ value }), type: "text", placeholder: "tech-1", autocomplete: "off" }) })
              : h.p([], [`Technician ID: ${model.editingTechnicianId}`]),
            field(h, { id: "technician-name", label: "Name", children: textInput(h, { id: "technician-name", value: model.technicianName, onInput: (value) => Message.ChangedTechnicianName({ value }), type: "text", placeholder: "Sam Technician", autocomplete: "off" }) }),
            field(h, { id: "technician-on-call", label: "On call", children: selectInput(h, { id: "technician-on-call", value: String(model.technicianOnCall), onChange: (value) => Message.ChangedTechnicianOnCall({ value }), choices: booleanChoices }) }),
            h.div([h.Class("actions")], [primaryButton(h, { label: model.editingTechnicianId === null ? "Create technician" : "Save technician", message: Option.none(), type: "submit", disabled: model.pending > 0 }), quietButton(h, { label: "Clear", message: Message.ClickedClearTechnician(), disabled: model.pending > 0 })]),
          ]),
          dataTable(h, { caption: "Technicians loaded for selector", columns: ["ID", "Name", "On call", ""], rows: model.technicians, key: (technician) => technician.id, cells: (technician) => [technician.id, technician.name, onCall(technician.onCall), quietButton(h, { label: "Edit", message: Message.ClickedEditTechnician({ id: technician.id }), disabled: model.pending > 0 })] }),
          model.pending > 0 ? h.p([], ["Loading technician pages…"]) : model.technicianCursor === null ? h.p([], ["All technician pages loaded."]) : pageButton(h, "Load next technicians", Message.ClickedNextTechnicians(), true),
        ]),
      ]),
    ],
  }),
})

