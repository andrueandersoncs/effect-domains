import { Effect, Option, Schema, pipe } from "effect"
import { RpcGroup } from "effect/unstable/rpc"
import { Runtime, type Update } from "foldkit"
import { type Document, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import { dataTable, field, primaryButton, quietButton, selectInput, shell, textInput, textareaInput } from "@effect-domains/example-web/html"
import { BrowserModel } from "effect-domains/browser-model"
import { Page } from "effect-domains/page"
import { ResourcePager } from "effect-domains/resource-pager"
import { Resource } from "effect-domains/resource"
import { Requests, RequestStateSchema, RequestTokenSchema } from "effect-domains/requests"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { RepairBoardList, RepairBoardPage, RepairBoardRowSchema } from "../board.ts"
import { CustomerSchema, RepairJobSchema, RepairStatusSchema, TechnicianSchema } from "../domain.ts"
import { CustomersResource, RepairJobsResource, TechniciansResource } from "../resources.ts"
import { RepairWorkshopOperations } from "../sqlite.ts"

const CustomerRowSchema = Resource.table(CustomersResource).rowSchema
const TechnicianRowSchema = Resource.table(TechniciansResource).rowSchema
const CustomerPageSchema = Resource.compile(CustomersResource).contracts.list.successSchema
const TechnicianPageSchema = Resource.compile(TechniciansResource).contracts.list.successSchema
const RepairJobRowSchema = Resource.table(RepairJobsResource).rowSchema
const RepairWorkshopWebRpcs = RpcGroup.make().merge(Resource.compile(CustomersResource).group, Resource.compile(TechniciansResource).group, Resource.compile(RepairJobsResource).group, RepairWorkshopOperations.group)
export const WebClient = RpcService.make({ name: "repair-workshop/WebClient", group: RepairWorkshopWebRpcs })
export type WebClient = Type<typeof WebClient>

const statuses = ["queued", "repairing", "ready"] as const
const statusChoices = statuses.map((value) => ({ value, label: value }))
const filterChoices = [{ value: "", label: "All statuses" }, ...statusChoices]
const booleanChoices = [{ value: "false", label: "No" }, { value: "true", label: "Yes" }]
export const Model = Schema.Struct({
  customers: Schema.Array(CustomerRowSchema), technicians: Schema.Array(TechnicianRowSchema), board: Schema.Array(RepairBoardRowSchema), customerCursor: Schema.NullOr(Schema.String), technicianCursor: Schema.NullOr(Schema.String), filterStatus: Schema.String,
  customerId: Schema.String, customerName: Schema.String, editingCustomerId: Schema.NullOr(Schema.String), technicianId: Schema.String, technicianName: Schema.String, technicianOnCall: Schema.Boolean, editingTechnicianId: Schema.NullOr(Schema.String),
  repairCustomerId: Schema.String, repairItem: Schema.String, repairFault: Schema.String, repairUrgent: Schema.Boolean, repairStatus: RepairStatusSchema, repairTechnicianId: Schema.String,
  requests: RequestStateSchema, fieldErrors: BrowserModel.FieldErrorsSchema, notice: BrowserModel.NoticeSchema,
})
export type Model = typeof Model.Type
export const Message = defineMessageUnion({
  ChangedFilterStatus: { value: Schema.String }, ChangedCustomerId: { value: Schema.String }, ChangedCustomerName: { value: Schema.String }, ChangedTechnicianId: { value: Schema.String }, ChangedTechnicianName: { value: Schema.String }, ChangedTechnicianOnCall: { value: Schema.String }, ChangedRepairCustomer: { value: Schema.String }, ChangedRepairItem: { value: Schema.String }, ChangedRepairFault: { value: Schema.String }, ChangedRepairUrgent: { value: Schema.String }, ChangedRepairStatus: { value: Schema.String }, ChangedRepairTechnician: { value: Schema.String },
  ClickedReload: {}, ClickedNextCustomers: {}, ClickedNextTechnicians: {}, ClickedSaveCustomer: {}, ClickedEditCustomer: { id: Schema.String }, ClickedClearCustomer: {}, ClickedSaveTechnician: {}, ClickedEditTechnician: { id: Schema.String }, ClickedClearTechnician: {}, ClickedCreateRepair: {}, ChangedBoardStatus: { id: Schema.String, value: Schema.String }, ChangedBoardTechnician: { id: Schema.String, value: Schema.String },
  SucceededCustomers: { page: CustomerPageSchema, append: Schema.Boolean, request: RequestTokenSchema }, SucceededTechnicians: { page: TechnicianPageSchema, append: Schema.Boolean, request: RequestTokenSchema }, SucceededBoard: { page: RepairBoardPage.success, request: RequestTokenSchema }, SucceededCustomer: { customer: CustomerRowSchema, created: Schema.Boolean, request: RequestTokenSchema }, SucceededTechnician: { technician: TechnicianRowSchema, created: Schema.Boolean, request: RequestTokenSchema }, SucceededRepair: { repair: RepairJobRowSchema, created: Schema.Boolean, request: RequestTokenSchema }, Failed: { request: RequestTokenSchema, error: Schema.String, fieldErrors: BrowserModel.FieldErrorsSchema },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient>
const failurePayload = (error: unknown) =>
  BrowserModel.failure(error, RpcBrowser.messageFromUnknown)
const emptyCustomer = { customerId: "", customerName: "", editingCustomerId: null as string | null }
const emptyTechnician = { technicianId: "", technicianName: "", technicianOnCall: false, editingTechnicianId: null as string | null }
const emptyRepair = { repairCustomerId: "", repairItem: "", repairFault: "", repairUrgent: false, repairStatus: "queued" as const, repairTechnicianId: "" }

export const LoadCustomers = RpcBrowser.command("LoadCustomers", {
  request: "customers.list",
  args: { cursor: Schema.NullOr(Schema.String), append: Schema.Boolean },
  success: Message.SucceededCustomers,
  failure: Message.Failed,
  execute: (args) => Effect.gen(function*() {
    const client = yield* WebClient
    const page = yield* client["customers.list"]({ limit: 50, ...Page.input(args.cursor) })

    return { page, append: args.append }
  }),
  failurePayload,
})

export const LoadTechnicians = RpcBrowser.command("LoadTechnicians", {
  request: "technicians.list",
  args: { cursor: Schema.NullOr(Schema.String), append: Schema.Boolean },
  success: Message.SucceededTechnicians,
  failure: Message.Failed,
  execute: (args) => Effect.gen(function*() {
    const client = yield* WebClient
    const page = yield* client["technicians.list"]({ limit: 50, ...Page.input(args.cursor) })

    return { page, append: args.append }
  }),
  failurePayload,
})

export const LoadBoard = RpcBrowser.command("LoadBoard", {
  request: "workshop.board",
  args: { status: Schema.String },
  success: Message.SucceededBoard,
  failure: Message.Failed,
  execute: ({ status }) => Effect.gen(function*() {
    const client = yield* WebClient
    const page = yield* client["workshop.board"]({
      limit: 50,
      ...(status === "" ? {} : { filter: { status: status as typeof RepairStatusSchema.Type } }),
    })

    return { page }
  }),
  failurePayload,
})

export const SaveCustomer = RpcBrowser.command("SaveCustomer", {
  request: "customers.save",
  args: {
    id: Schema.String,
    name: Schema.String,
    editingId: Schema.NullOr(Schema.String),
  },
  success: Message.SucceededCustomer,
  failure: Message.Failed,
  execute: (args) => Effect.gen(function*() {
    const id = yield* Schema.decodeUnknownEffect(CustomerSchema.fields.id)(args.id.trim())
      .pipe(Effect.mapError(BrowserModel.fieldFailure("customerId")))
    const name = yield* Schema.decodeUnknownEffect(CustomerSchema.fields.name)(args.name.trim())
      .pipe(Effect.mapError(BrowserModel.fieldFailure("customerName")))
    const client = yield* WebClient
    const created = args.editingId === null
    const customer = yield* (created
      ? client["customers.create"]({ id, name })
      : client["customers.patch"]({ key: args.editingId, changes: { name } }))

    return { customer, created }
  }),
  failurePayload,
})

export const SaveTechnician = RpcBrowser.command("SaveTechnician", {
  request: "technicians.save",
  args: {
    id: Schema.String,
    name: Schema.String,
    onCall: Schema.Boolean,
    editingId: Schema.NullOr(Schema.String),
  },
  success: Message.SucceededTechnician,
  failure: Message.Failed,
  execute: (args) => Effect.gen(function*() {
    const id = yield* Schema.decodeUnknownEffect(TechnicianSchema.fields.id)(args.id.trim())
      .pipe(Effect.mapError(BrowserModel.fieldFailure("technicianId")))
    const name = yield* Schema.decodeUnknownEffect(TechnicianSchema.fields.name)(args.name.trim())
      .pipe(Effect.mapError(BrowserModel.fieldFailure("technicianName")))
    const client = yield* WebClient
    const created = args.editingId === null
    const technician = yield* (created
      ? client["technicians.create"]({ id, name, onCall: args.onCall })
      : client["technicians.patch"]({
        key: args.editingId,
        changes: { name, onCall: args.onCall },
      }))

    return { technician, created }
  }),
  failurePayload,
})

export const SaveRepair = RpcBrowser.command("SaveRepair", {
  request: "repair_jobs.save",
  args: {
    customerId: Schema.String,
    item: Schema.String,
    fault: Schema.String,
    urgent: Schema.Boolean,
    status: RepairStatusSchema,
    technicianId: Schema.String,
  },
  success: Message.SucceededRepair,
  failure: Message.Failed,
  execute: (args) => Effect.gen(function*() {
    const customerId = yield* Schema.decodeUnknownEffect(RepairJobSchema.fields.customerId)(
      args.customerId.trim(),
    ).pipe(Effect.mapError(BrowserModel.fieldFailure("repairCustomerId")))
    const item = yield* Schema.decodeUnknownEffect(RepairJobSchema.fields.item)(args.item.trim())
      .pipe(Effect.mapError(BrowserModel.fieldFailure("repairItem")))
    const fault = yield* Schema.decodeUnknownEffect(RepairJobSchema.fields.fault)(args.fault.trim())
      .pipe(Effect.mapError(BrowserModel.fieldFailure("repairFault")))
    const technicianId = args.technicianId === ""
      ? null
      : yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(args.technicianId)
        .pipe(Effect.mapError(BrowserModel.fieldFailure("repairTechnicianId")))
    const client = yield* WebClient
    const repair = yield* client["repair_jobs.create"]({
      customerId,
      item,
      fault,
      urgent: args.urgent,
      status: args.status,
      technicianId,
    })

    return { repair, created: true }
  }),
  failurePayload,
})

export const PatchRepairStatus = RpcBrowser.command("PatchRepairStatus", {
  request: { key: { prefix: "repair_jobs.status", fields: ["id"] }, concurrency: "latest" },
  args: { id: Schema.String, status: RepairStatusSchema },
  success: Message.SucceededRepair,
  failure: Message.Failed,
  execute: ({ id, status }) => Effect.gen(function*() {
    const client = yield* WebClient
    const repair = yield* client["repair_jobs.patch"]({ key: id, changes: { status } })

    return { repair, created: false }
  }),
  failurePayload,
})

export const PatchRepairTechnician = RpcBrowser.command("PatchRepairTechnician", {
  request: { key: { prefix: "repair_jobs.technician", fields: ["id"] }, concurrency: "latest" },
  args: { id: Schema.String, technicianId: Schema.NullOr(Schema.String) },
  success: Message.SucceededRepair,
  failure: Message.Failed,
  execute: ({ id, technicianId }) => Effect.gen(function*() {
    const client = yield* WebClient
    const repair = yield* client["repair_jobs.patch"]({ key: id, changes: { technicianId } })

    return { repair, created: false }
  }),
  failurePayload,
})

const CustomersPager = ResourcePager.make("customers.list")
const TechniciansPager = ResourcePager.make("technicians.list")
const customersState = (model: Model) => ({ page: { items: model.customers, nextCursor: model.customerCursor }, requests: model.requests })
const techniciansState = (model: Model) => ({ page: { items: model.technicians, nextCursor: model.technicianCursor }, requests: model.requests })
const refresh = (model: Model) => {
  const customers = pipe(CustomersPager.begin(model.requests, customersState(model).page, false), Option.getOrThrow)
  const technicians = pipe(TechniciansPager.begin(customers.requests, techniciansState(model).page, false), Option.getOrThrow)
  const board = LoadBoard.start({ ...model, requests: technicians.requests }, { status: model.filterStatus })
  return {
    customers: customers.page,
    technicians: technicians.page,
    state: board.model.requests,
    commands: [
      LoadCustomers.command({ cursor: customers.cursor, append: customers.append, request: customers.request }),
      LoadTechnicians.command({ cursor: technicians.cursor, append: technicians.append, request: technicians.request }),
      ...board.commands,
    ],
  }
}
const beginCustomers = (model: Model, append: boolean) => {
  const started = pipe(CustomersPager.begin(model.requests, customersState(model).page, append), Option.getOrThrow)
  return { page: started.page, state: started.requests, command: LoadCustomers.command({ cursor: started.cursor, append: started.append, request: started.request }) }
}
const beginTechnicians = (model: Model, append: boolean) => {
  const started = pipe(TechniciansPager.begin(model.requests, techniciansState(model).page, append), Option.getOrThrow)
  return { page: started.page, state: started.requests, command: LoadTechnicians.command({ cursor: started.cursor, append: started.append, request: started.request }) }
}

export const update = (model: Model, message: Message) => Message.match<UpdateReturn>(message, {
  ChangedFilterStatus: ({ value }) => RpcBrowser.invalidate(model, LoadBoard.requestKey, { filterStatus: value, board: [] }), ChangedCustomerId: ({ value }) => ({ model: evo(model, { customerId: () => value }) }), ChangedCustomerName: ({ value }) => ({ model: evo(model, { customerName: () => value }) }), ChangedTechnicianId: ({ value }) => ({ model: evo(model, { technicianId: () => value }) }), ChangedTechnicianName: ({ value }) => ({ model: evo(model, { technicianName: () => value }) }), ChangedTechnicianOnCall: ({ value }) => ({ model: evo(model, { technicianOnCall: () => value === "true" }) }), ChangedRepairCustomer: ({ value }) => ({ model: evo(model, { repairCustomerId: () => value }) }), ChangedRepairItem: ({ value }) => ({ model: evo(model, { repairItem: () => value }) }), ChangedRepairFault: ({ value }) => ({ model: evo(model, { repairFault: () => value }) }), ChangedRepairUrgent: ({ value }) => ({ model: evo(model, { repairUrgent: () => value === "true" }) }), ChangedRepairStatus: ({ value }) => ({ model: evo(model, { repairStatus: () => value as Model["repairStatus"] }) }), ChangedRepairTechnician: ({ value }) => ({ model: evo(model, { repairTechnicianId: () => value }) }),
  ClickedReload: () => {
    const next = refresh(model)
    return { model: evo(model, { customers: () => next.customers.items, technicians: () => next.technicians.items, board: () => [], customerCursor: () => next.customers.nextCursor, technicianCursor: () => next.technicians.nextCursor, requests: () => next.state, notice: () => null }), commands: next.commands }
  },
  ClickedNextCustomers: () => model.customerCursor === null || CustomersPager.pending(model.requests) ? { model } : (() => {
    const next = beginCustomers(model, true)
    return { model: evo(model, { customers: () => next.page.items, customerCursor: () => next.page.nextCursor, requests: () => next.state }), commands: [next.command] }
  })(),
  ClickedNextTechnicians: () => model.technicianCursor === null || TechniciansPager.pending(model.requests) ? { model } : (() => {
    const next = beginTechnicians(model, true)
    return { model: evo(model, { technicians: () => next.page.items, technicianCursor: () => next.page.nextCursor, requests: () => next.state }), commands: [next.command] }
  })(),
  ClickedSaveCustomer: () => SaveCustomer.start(model, { id: model.customerId, name: model.customerName, editingId: model.editingCustomerId }, { fieldErrors: {}, notice: null }),
  ClickedEditCustomer: ({ id }) => { const customer = model.customers.find((item) => item.id === id); return customer === undefined ? { model } : { model: evo(model, { customerId: () => customer.id, customerName: () => customer.name, editingCustomerId: () => customer.id, fieldErrors: () => ({}), notice: () => null }) } },
  ClickedClearCustomer: () => ({ model: evo(model, { customerId: () => "", customerName: () => "", editingCustomerId: () => null, fieldErrors: () => ({}), notice: () => null }) }),
  ClickedSaveTechnician: () => SaveTechnician.start(model, { id: model.technicianId, name: model.technicianName, onCall: model.technicianOnCall, editingId: model.editingTechnicianId }, { fieldErrors: {}, notice: null }),
  ClickedEditTechnician: ({ id }) => { const technician = model.technicians.find((item) => item.id === id); return technician === undefined ? { model } : { model: evo(model, { technicianId: () => technician.id, technicianName: () => technician.name, technicianOnCall: () => technician.onCall, editingTechnicianId: () => technician.id, fieldErrors: () => ({}), notice: () => null }) } },
  ClickedClearTechnician: () => ({ model: evo(model, { technicianId: () => "", technicianName: () => "", technicianOnCall: () => false, editingTechnicianId: () => null, fieldErrors: () => ({}), notice: () => null }) }),
  ClickedCreateRepair: () => SaveRepair.start(model, { customerId: model.repairCustomerId, item: model.repairItem, fault: model.repairFault, urgent: model.repairUrgent, status: model.repairStatus, technicianId: model.repairTechnicianId }, { fieldErrors: {}, notice: null }),
  ChangedBoardStatus: ({ id, value }) => PatchRepairStatus.start(model, { id, status: value as Model["repairStatus"] }, { notice: null }),
  ChangedBoardTechnician: ({ id, value }) => PatchRepairTechnician.start(model, { id, technicianId: value === "" ? null : value }, { notice: null }),
  SucceededCustomers: ({ page, append, request }) => Option.match(CustomersPager.receive(customersState(model), request, page, append), {
    onNone: () => ({ model }),
    onSome: (received) => ({ model: evo(model, { customers: () => received.page.items, customerCursor: () => received.page.nextCursor, requests: () => received.requests }) }),
  }),
  SucceededTechnicians: ({ page, append, request }) => Option.match(TechniciansPager.receive(techniciansState(model), request, page, append), {
    onNone: () => ({ model }),
    onSome: (received) => ({ model: evo(model, { technicians: () => received.page.items, technicianCursor: () => received.page.nextCursor, requests: () => received.requests }) }),
  }),
  SucceededBoard: ({ page, request }) => RpcBrowser.succeed(model, request, { board: page.items }),
  SucceededCustomer: ({ created, request }) => {
    const settled = RpcBrowser.succeed(model, request)
    if (!settled.accepted) return { model }
    const next = refresh(settled.model)
    return { model: evo(settled.model, { customerId: () => "", customerName: () => "", editingCustomerId: () => null, customers: () => next.customers.items, technicians: () => next.technicians.items, board: () => [], customerCursor: () => next.customers.nextCursor, technicianCursor: () => next.technicians.nextCursor, requests: () => next.state, notice: () => ({ kind: "success" as const, text: created ? "Customer created." : "Customer updated." }) }), commands: next.commands }
  },
  SucceededTechnician: ({ created, request }) => {
    const settled = RpcBrowser.succeed(model, request)
    if (!settled.accepted) return { model }
    const next = refresh(settled.model)
    return { model: evo(settled.model, { technicianId: () => "", technicianName: () => "", technicianOnCall: () => false, editingTechnicianId: () => null, customers: () => next.customers.items, technicians: () => next.technicians.items, board: () => [], customerCursor: () => next.customers.nextCursor, technicianCursor: () => next.technicians.nextCursor, requests: () => next.state, notice: () => ({ kind: "success" as const, text: created ? "Technician created." : "Technician updated." }) }), commands: next.commands }
  },
  SucceededRepair: ({ created, request }) => {
    const settled = RpcBrowser.succeed(model, request)
    if (!settled.accepted) return { model }
    const next = refresh(settled.model)
    return { model: evo(settled.model, { repairCustomerId: () => "", repairItem: () => "", repairFault: () => "", repairUrgent: () => false, repairStatus: () => "queued", repairTechnicianId: () => "", customers: () => next.customers.items, technicians: () => next.technicians.items, board: () => [], customerCursor: () => next.customers.nextCursor, technicianCursor: () => next.technicians.nextCursor, requests: () => next.state, notice: () => ({ kind: "success" as const, text: created ? "Repair created." : "Repair updated." }) }), commands: next.commands }
  },
  Failed: ({ request, error, fieldErrors }) => RpcBrowser.fail(model, request, error, {
    fieldErrors: { ...model.fieldErrors, ...fieldErrors },
    notice: { kind: "error" as const, text: error },
  }),
})
export const init: Runtime.ApplicationInit<Model, Message, void, WebClient> = () => {
  const model: Model = { customers: [], technicians: [], board: [], customerCursor: null, technicianCursor: null, filterStatus: "", ...emptyCustomer, ...emptyTechnician, ...emptyRepair, requests: Requests.empty(), fieldErrors: BrowserModel.emptyFieldErrors(), notice: null }
  const next = refresh(model)
  return { model: evo(model, { customers: () => next.customers.items, technicians: () => next.technicians.items, customerCursor: () => next.customers.nextCursor, technicianCursor: () => next.technicians.nextCursor, requests: () => next.state }), commands: next.commands }
}
const technicianChoices = (technicians: ReadonlyArray<typeof TechnicianRowSchema.Type>) => [{ value: "", label: "Unassigned" }, ...technicians.map((technician) => ({ value: technician.id, label: `${technician.name} (${technician.id})` }))]
const customerChoices = (customers: ReadonlyArray<typeof CustomerRowSchema.Type>) => [{ value: "", label: "Choose a customer" }, ...customers.map((customer) => ({ value: customer.id, label: `${customer.name} (${customer.id})` }))]
const repairTechnicianChoices = (technicians: ReadonlyArray<typeof TechnicianRowSchema.Type>, repair: typeof RepairBoardRowSchema.Type) => repair.technicianId === null || technicians.some((technician) => technician.id === repair.technicianId) ? technicianChoices(technicians) : [...technicianChoices(technicians), { value: repair.technicianId, label: `${repair.technicianName} (${repair.technicianId})` }]
const onCall = (value: boolean | null) => value === null ? "—" : value ? "Yes" : "No"
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({ title: "Repair workshop", body: shell(h, { title: "Repair workshop", lede: "Create customers, technicians, and repairs. The board is a joined projection and shows the first 50 matching repairs.", notice: model.notice, session: null, children: [
  h.section([h.Class("panel stack")], [h.div([h.Class("actions")], [field(h, { id: "board-status", label: "Board status", children: selectInput(h, { id: "board-status", value: model.filterStatus, onChange: (value) => Message.ChangedFilterStatus({ value }), choices: filterChoices }) }), primaryButton(h, { label: RpcBrowser.pending(model) ? "Loading…" : "Reload", message: Option.some(Message.ClickedReload()), type: "button", disabled: RpcBrowser.pending(model) })]), dataTable(h, { caption: "Repair board", columns: ["Customer", "Item", "Fault", "Urgent", "Status", "Technician", "On call"], rows: model.board, key: (repair) => repair.id, cells: (repair) => [`${repair.customerName} (${repair.customerId})`, repair.item, repair.fault, repair.urgent ? "Yes" : "No", selectInput(h, { id: `repair-status-${repair.id}`, value: repair.status, onChange: (value) => Message.ChangedBoardStatus({ id: repair.id, value }), choices: statusChoices }), selectInput(h, { id: `repair-technician-${repair.id}`, value: repair.technicianId ?? "", onChange: (value) => Message.ChangedBoardTechnician({ id: repair.id, value }), choices: repairTechnicianChoices(model.technicians, repair) }), onCall(repair.technicianOnCall)] })]),
  h.div([h.Class("split")], [h.section([h.Class("panel stack")], [h.form([h.Class("stack"), h.OnSubmit(Message.ClickedCreateRepair())], [h.h2([], ["Create repair"]), field(h, { id: "repair-customer", label: "Customer", children: selectInput(h, { id: "repair-customer", value: model.repairCustomerId, onChange: (value) => Message.ChangedRepairCustomer({ value }), choices: customerChoices(model.customers) }), error: model.fieldErrors.repairCustomerId }), field(h, { id: "repair-item", label: "Item", children: textInput(h, { id: "repair-item", value: model.repairItem, onInput: (value) => Message.ChangedRepairItem({ value }), type: "text", placeholder: "Espresso machine", autocomplete: "off" }), error: model.fieldErrors.repairItem }), field(h, { id: "repair-fault", label: "Fault", children: textareaInput(h, { id: "repair-fault", value: model.repairFault, onInput: (value) => Message.ChangedRepairFault({ value }), rows: 3 }), error: model.fieldErrors.repairFault }), h.div([h.Class("actions")], [field(h, { id: "repair-urgent", label: "Urgent", children: selectInput(h, { id: "repair-urgent", value: String(model.repairUrgent), onChange: (value) => Message.ChangedRepairUrgent({ value }), choices: booleanChoices }) }), field(h, { id: "repair-new-status", label: "Status", children: selectInput(h, { id: "repair-new-status", value: model.repairStatus, onChange: (value) => Message.ChangedRepairStatus({ value }), choices: statusChoices }) }), field(h, { id: "repair-technician", label: "Technician", children: selectInput(h, { id: "repair-technician", value: model.repairTechnicianId, onChange: (value) => Message.ChangedRepairTechnician({ value }), choices: technicianChoices(model.technicians) }) })]), primaryButton(h, { label: "Create repair", message: Option.none(), type: "submit", disabled: RpcBrowser.pending(model, "repair_jobs.save") })])]),
  h.section([h.Class("panel stack")], [h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSaveCustomer())], [h.h2([], [model.editingCustomerId === null ? "Create customer" : "Edit customer"]), model.editingCustomerId === null ? field(h, { id: "customer-id", label: "Customer ID", children: textInput(h, { id: "customer-id", value: model.customerId, onInput: (value) => Message.ChangedCustomerId({ value }), type: "text", placeholder: "customer-1", autocomplete: "off" }), error: model.fieldErrors.customerId }) : h.p([], [`Customer ID: ${model.editingCustomerId}`]), field(h, { id: "customer-name", label: "Name", children: textInput(h, { id: "customer-name", value: model.customerName, onInput: (value) => Message.ChangedCustomerName({ value }), type: "text", placeholder: "Ada Customer", autocomplete: "off" }), error: model.fieldErrors.customerName }), h.div([h.Class("actions")], [primaryButton(h, { label: model.editingCustomerId === null ? "Create customer" : "Save customer", message: Option.none(), type: "submit", disabled: RpcBrowser.pending(model, "customers.save") }), quietButton(h, { label: "Clear", message: Message.ClickedClearCustomer(), disabled: false })])]), dataTable(h, { caption: "Customers loaded for selector", columns: ["ID", "Name", ""], rows: model.customers, key: (customer) => customer.id, cells: (customer) => [customer.id, customer.name, quietButton(h, { label: "Edit", message: Message.ClickedEditCustomer({ id: customer.id }), disabled: false })] }), model.customerCursor === null ? h.p([], ["All customer pages loaded."]) : quietButton(h, { label: "Load next customers", message: Message.ClickedNextCustomers(), disabled: RpcBrowser.pending(model, "customers.list") }), h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSaveTechnician())], [h.h2([], [model.editingTechnicianId === null ? "Create technician" : "Edit technician"]), model.editingTechnicianId === null ? field(h, { id: "technician-id", label: "Technician ID", children: textInput(h, { id: "technician-id", value: model.technicianId, onInput: (value) => Message.ChangedTechnicianId({ value }), type: "text", placeholder: "tech-1", autocomplete: "off" }), error: model.fieldErrors.technicianId }) : h.p([], [`Technician ID: ${model.editingTechnicianId}`]), field(h, { id: "technician-name", label: "Name", children: textInput(h, { id: "technician-name", value: model.technicianName, onInput: (value) => Message.ChangedTechnicianName({ value }), type: "text", placeholder: "Sam Technician", autocomplete: "off" }), error: model.fieldErrors.technicianName }), field(h, { id: "technician-on-call", label: "On call", children: selectInput(h, { id: "technician-on-call", value: String(model.technicianOnCall), onChange: (value) => Message.ChangedTechnicianOnCall({ value }), choices: booleanChoices }) }), h.div([h.Class("actions")], [primaryButton(h, { label: model.editingTechnicianId === null ? "Create technician" : "Save technician", message: Option.none(), type: "submit", disabled: RpcBrowser.pending(model, "technicians.save") }), quietButton(h, { label: "Clear", message: Message.ClickedClearTechnician(), disabled: false })])]), dataTable(h, { caption: "Technicians loaded for selector", columns: ["ID", "Name", "On call", ""], rows: model.technicians, key: (technician) => technician.id, cells: (technician) => [technician.id, technician.name, onCall(technician.onCall), quietButton(h, { label: "Edit", message: Message.ClickedEditTechnician({ id: technician.id }), disabled: false })] }), model.technicianCursor === null ? h.p([], ["All technician pages loaded."]) : quietButton(h, { label: "Load next technicians", message: Message.ClickedNextTechnicians(), disabled: RpcBrowser.pending(model, "technicians.list") })])])
] }) })
