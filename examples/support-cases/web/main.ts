import { DateTime, Effect, Option, Schema, pipe } from "effect"
import { RpcGroup } from "effect/unstable/rpc"
import { Runtime, type Update } from "foldkit"
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
import { BrowserModel } from "effect-domains/browser-model"
import { Resource } from "effect-domains/resource"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { Requests, RequestStateSchema, RequestTokenSchema } from "effect-domains/requests"
import { SupportCaseBoardList, SupportCaseBoardPage, SupportCaseBoardRowSchema } from "../board.ts"
import { SupportCaseDetail } from "../contracts.ts"
import {
  SupportAgentSchema,
  SupportCasePrioritySchema,
  SupportCaseSchema,
  SupportCaseStatusSchema,
  SupportCaseTransitions,
  SupportCustomerSchema,
} from "../domain.ts"
import {
  SupportAgentsResource,
  SupportCasesResource,
  SupportCustomersResource,
} from "../resources.ts"
import { SupportCaseOperations } from "../sqlite.ts"

const SupportCasesWebRpcs = RpcGroup.make().merge(
  Resource.compile(SupportCustomersResource).group,
  Resource.compile(SupportAgentsResource).group,
  Resource.compile(SupportCasesResource).group,
  SupportCaseOperations.group,
)

export const WebClient = RpcService.make({ name: "support-cases/WebClient", group: SupportCasesWebRpcs })
export type WebClient = Type<typeof WebClient>

const CustomerRowSchema = Resource.table(SupportCustomersResource).rowSchema
const AgentRowSchema = Resource.table(SupportAgentsResource).rowSchema
const CaseRowSchema = Resource.table(SupportCasesResource).rowSchema
const statuses = ["open", "triaged", "assigned", "resolved"] as const
const priorities = ["low", "normal", "high", "urgent"] as const
const actions = ["triage", "assign", "resolve", "reopen"] as const
const statusChoices = statuses.map((value) => ({ value, label: value }))
const filterStatusChoices = [{ value: "", label: "All statuses" }, ...statusChoices]
const priorityChoices = priorities.map((value) => ({ value, label: value }))
const actionChoices = actions.map((value) => ({ value, label: value }))
const dutyChoices = [{ value: "false", label: "Off duty" }, { value: "true", label: "On duty" }]

export const Model = Schema.Struct({
  customers: Schema.Array(CustomerRowSchema),
  agents: Schema.Array(AgentRowSchema),
  board: Schema.Array(SupportCaseBoardRowSchema),
  detail: Schema.NullOr(SupportCaseDetail),
  customerId: Schema.String,
  customerName: Schema.String,
  agentId: Schema.String,
  agentName: Schema.String,
  agentOnDuty: Schema.Boolean,
  caseCustomerId: Schema.String,
  caseSubject: Schema.String,
  casePriority: SupportCasePrioritySchema,
  filterStatus: Schema.String,
  selectedCaseId: Schema.NullOr(Schema.String),
  transitionAction: SupportCaseTransitions.actions,
  transitionAgentId: Schema.String,
  transitionNote: Schema.String,
  requests: RequestStateSchema,
  notice: BrowserModel.NoticeSchema,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedCustomerId: { value: Schema.String },
  ChangedCustomerName: { value: Schema.String },
  ChangedAgentId: { value: Schema.String },
  ChangedAgentName: { value: Schema.String },
  ChangedAgentOnDuty: { value: Schema.String },
  ChangedCaseCustomerId: { value: Schema.String },
  ChangedCaseSubject: { value: Schema.String },
  ChangedCasePriority: { value: Schema.String },
  ChangedFilterStatus: { value: Schema.String },
  ChangedTransitionAction: { value: Schema.String },
  ChangedTransitionAgentId: { value: Schema.String },
  ChangedTransitionNote: { value: Schema.String },
  ClickedCreateCustomer: {},
  ClickedCreateAgent: {},
  ClickedOpenCase: {},
  ClickedReload: {},
  ClickedInspectCase: { id: Schema.String },
  ClickedAdvanceCase: {},
  SucceededCustomers: { customers: Schema.Array(CustomerRowSchema), request: RequestTokenSchema },
  SucceededAgents: { agents: Schema.Array(AgentRowSchema), request: RequestTokenSchema },
  SucceededBoard: { page: SupportCaseBoardPage.success, request: RequestTokenSchema },
  SucceededDetail: { detail: SupportCaseDetail, request: RequestTokenSchema },
  SucceededCustomer: { customer: CustomerRowSchema, request: RequestTokenSchema },
  SucceededAgent: { agent: AgentRowSchema, request: RequestTokenSchema },
  SucceededCase: { supportCase: CaseRowSchema, action: Schema.String, request: RequestTokenSchema },
  Failed: { request: RequestTokenSchema, error: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message, WebClient>

export const LoadCustomers = RpcBrowser.command("LoadCustomers", {
  request: "customers",
  args: {},
  success: Message.SucceededCustomers,
  failure: Message.Failed,
  execute: () => pipe(
    WebClient,
    Effect.flatMap((client) => client["support_customers.list"]({ limit: 50 })),
    Effect.map((page) => ({ customers: page.items })),
  ),
})

export const LoadAgents = RpcBrowser.command("LoadAgents", {
  request: "agents",
  args: {},
  success: Message.SucceededAgents,
  failure: Message.Failed,
  execute: () => pipe(
    WebClient,
    Effect.flatMap((client) => client["support_agents.list"]({ limit: 50 })),
    Effect.map((page) => ({ agents: page.items })),
  ),
})

export const LoadBoard = RpcBrowser.command("LoadBoard", {
  request: "board",
  args: { status: Schema.String },
  success: Message.SucceededBoard,
  failure: Message.Failed,
  execute: ({ status }) => pipe(
    WebClient,
    Effect.flatMap((client) => client["support.board"]({
      limit: 50,
      ...(status === "" ? {} : { filter: { status: status as typeof SupportCaseStatusSchema.Type } }),
    })),
    Effect.map((page) => ({ page })),
  ),
})

export const LoadDetail = RpcBrowser.command("LoadDetail", {
  request: "detail",
  args: { id: Schema.String },
  success: Message.SucceededDetail,
  failure: Message.Failed,
  execute: ({ id }) => pipe(
    WebClient,
    Effect.flatMap((client) => client["support.caseDetail"]({ caseId: id })),
    Effect.map((detail) => ({ detail })),
  ),
})

export const CreateCustomer = RpcBrowser.command("CreateCustomer", {
  request: { key: "mutation", concurrency: "exhaust" },
  args: { id: Schema.String, name: Schema.String },
  success: Message.SucceededCustomer,
  failure: Message.Failed,
  execute: ({ id, name }) => Effect.gen(function* () {
    const customerId = yield* Schema.decodeUnknownEffect(SupportCustomerSchema.fields.id)(id.trim())
    const customerName = yield* Schema.decodeUnknownEffect(SupportCustomerSchema.fields.name)(name.trim())
    const client = yield* WebClient
    const customer = yield* client["support_customers.create"]({ id: customerId, name: customerName })

    return { customer }
  }),
})

export const CreateAgent = RpcBrowser.command("CreateAgent", {
  request: { key: "mutation", concurrency: "exhaust" },
  args: { id: Schema.String, name: Schema.String, onDuty: Schema.Boolean },
  success: Message.SucceededAgent,
  failure: Message.Failed,
  execute: ({ id, name, onDuty }) => Effect.gen(function* () {
    const agentId = yield* Schema.decodeUnknownEffect(SupportAgentSchema.fields.id)(id.trim())
    const agentName = yield* Schema.decodeUnknownEffect(SupportAgentSchema.fields.name)(name.trim())
    const client = yield* WebClient
    const agent = yield* client["support_agents.create"]({ id: agentId, name: agentName, onDuty })

    return { agent }
  }),
})

export const OpenCase = RpcBrowser.command("OpenCase", {
  request: { key: "mutation", concurrency: "exhaust" },
  args: {
    customerId: Schema.String,
    subject: Schema.String,
    priority: SupportCasePrioritySchema,
  },
  success: Message.SucceededCase,
  failure: Message.Failed,
  execute: ({ customerId, subject, priority }) => Effect.gen(function* () {
    const decodedCustomerId = yield* Schema.decodeUnknownEffect(SupportCaseSchema.fields.customerId)(customerId)
    const decodedSubject = yield* Schema.decodeUnknownEffect(SupportCaseSchema.fields.subject)(subject.trim())
    const client = yield* WebClient
    const supportCase = yield* client["support.openCase"]({
      customerId: decodedCustomerId,
      subject: decodedSubject,
      priority,
    })

    return { supportCase, action: "Case opened." }
  }),
})

export const AdvanceCase = RpcBrowser.command("AdvanceCase", {
  request: { key: "mutation", concurrency: "exhaust" },
  args: {
    id: Schema.String,
    expectedVersion: Schema.Number,
    action: SupportCaseTransitions.actions,
    assignedAgentId: Schema.String,
    note: Schema.String,
  },
  success: Message.SucceededCase,
  failure: Message.Failed,
  execute: ({ id, expectedVersion, action, assignedAgentId, note }) => pipe(
    WebClient,
    Effect.flatMap((client) => client["support.advanceCase"]({
      caseId: id,
      expectedVersion,
      action,
      ...(action === "assign" ? { assignedAgentId } : {}),
      ...(note.trim() === "" ? {} : { note: note.trim() }),
    })),
    Effect.map((supportCase) => ({
      supportCase,
      action: `Case ${action} completed.`,
    })),
  ),
})

const startRefresh = (model: Model) => {
  const customers = LoadCustomers.start(model, {}, { board: [], notice: null })
  const agents = LoadAgents.start(customers.model, {})
  const board = LoadBoard.start(agents.model, { status: model.filterStatus })

  return {
    model: board.model,
    commands: [...customers.commands, ...agents.commands, ...board.commands],
  }
}

const startCaseRefresh = (model: Model, id: string) => {
  const board = LoadBoard.start(model, { status: model.filterStatus })
  const detail = LoadDetail.start(board.model, { id })

  return {
    model: detail.model,
    commands: [...board.commands, ...detail.commands],
  }
}

const nextAction = (status: typeof SupportCaseStatusSchema.Type): typeof SupportCaseTransitions.actions.Type => {
  if (status === "open") return "triage"
  if (status === "triaged") return "assign"
  if (status === "assigned") return "resolve"
  return "reopen"
}

const pending = (model: Model, key: string) => RpcBrowser.pending(model, key)

export const update = (model: Model, message: Message) => Message.match<UpdateReturn>(message, {
  ChangedCustomerId: ({ value }) => ({ model: evo(model, { customerId: () => value }) }),
  ChangedCustomerName: ({ value }) => ({ model: evo(model, { customerName: () => value }) }),
  ChangedAgentId: ({ value }) => ({ model: evo(model, { agentId: () => value }) }),
  ChangedAgentName: ({ value }) => ({ model: evo(model, { agentName: () => value }) }),
  ChangedAgentOnDuty: ({ value }) => ({ model: evo(model, { agentOnDuty: () => value === "true" }) }),
  ChangedCaseCustomerId: ({ value }) => ({ model: evo(model, { caseCustomerId: () => value }) }),
  ChangedCaseSubject: ({ value }) => ({ model: evo(model, { caseSubject: () => value }) }),
  ChangedCasePriority: ({ value }) => ({ model: evo(model, { casePriority: () => value as typeof SupportCasePrioritySchema.Type }) }),
  ChangedFilterStatus: ({ value }) => ({ model: evo(model, { filterStatus: () => value, board: () => [] }) }),
  ChangedTransitionAction: ({ value }) => ({ model: evo(model, { transitionAction: () => value as typeof SupportCaseTransitions.actions.Type }) }),
  ChangedTransitionAgentId: ({ value }) => ({ model: evo(model, { transitionAgentId: () => value }) }),
  ChangedTransitionNote: ({ value }) => ({ model: evo(model, { transitionNote: () => value }) }),
  ClickedCreateCustomer: () => CreateCustomer.start(model, {
    id: model.customerId,
    name: model.customerName,
  }, { notice: null }),
  ClickedCreateAgent: () => CreateAgent.start(model, {
    id: model.agentId,
    name: model.agentName,
    onDuty: model.agentOnDuty,
  }, { notice: null }),
  ClickedOpenCase: () => OpenCase.start(model, {
    customerId: model.caseCustomerId,
    subject: model.caseSubject,
    priority: model.casePriority,
  }, { notice: null }),
  ClickedReload: () => startRefresh(model),
  ClickedInspectCase: ({ id }) => LoadDetail.start(model, { id }, {
    selectedCaseId: id,
    detail: null,
    notice: null,
  }),
  ClickedAdvanceCase: () => model.detail === null
    ? { model }
    : AdvanceCase.start(model, {
      id: model.detail.case.id,
      expectedVersion: model.detail.case.version,
      action: model.transitionAction,
      assignedAgentId: model.transitionAgentId,
      note: model.transitionNote,
    }, { notice: null }),
  SucceededCustomers: ({ customers, request }) => RpcBrowser.succeed(model, request, { customers }),
  SucceededAgents: ({ agents, request }) => RpcBrowser.succeed(model, request, { agents }),
  SucceededBoard: ({ page, request }) => RpcBrowser.succeed(model, request, { board: page.items }),
  SucceededDetail: ({ detail, request }) => RpcBrowser.succeed(model, request, {
    detail,
    selectedCaseId: detail.case.id,
    transitionAction: nextAction(detail.case.status),
    transitionAgentId: detail.case.assignedAgentId ?? "",
  }),
  SucceededCustomer: ({ customer, request }) => {
    const settled = RpcBrowser.succeed(model, request, {
      customerId: "",
      customerName: "",
      caseCustomerId: customer.id,
      notice: { kind: "success" as const, text: "Customer created." },
    })
    return settled.accepted ? LoadCustomers.start(settled.model, {}) : { model }
  },
  SucceededAgent: ({ agent, request }) => {
    const settled = RpcBrowser.succeed(model, request, {
      agentId: "",
      agentName: "",
      transitionAgentId: agent.id,
      notice: { kind: "success" as const, text: "Agent created." },
    })
    return settled.accepted ? LoadAgents.start(settled.model, {}) : { model }
  },
  SucceededCase: ({ supportCase, action, request }) => {
    const settled = RpcBrowser.succeed(model, request, {
      selectedCaseId: supportCase.id,
      caseSubject: "",
      transitionAction: nextAction(supportCase.status),
      transitionAgentId: supportCase.assignedAgentId ?? model.transitionAgentId,
      transitionNote: "",
      notice: { kind: "success" as const, text: action },
    })
    return settled.accepted ? startCaseRefresh(settled.model, supportCase.id) : { model }
  },
  Failed: ({ request, error }) => RpcBrowser.fail(model, request, error, {
    notice: { kind: "error" as const, text: error },
  }),
})

export const init: Runtime.ApplicationInit<Model, Message, void, WebClient> = () => {
  const model: Model = {
    customers: [],
    agents: [],
    board: [],
    detail: null,
    customerId: "",
    customerName: "",
    agentId: "",
    agentName: "",
    agentOnDuty: true,
    caseCustomerId: "",
    caseSubject: "",
    casePriority: "normal",
    filterStatus: "",
    selectedCaseId: null,
    transitionAction: "triage",
    transitionAgentId: "",
    transitionNote: "",
    requests: Requests.empty(),
    notice: null,
  }
  return startRefresh(model)
}

const customerChoices = (model: Model) => [
  { value: "", label: "Choose a customer" },
  ...model.customers.map((customer) => ({ value: customer.id, label: `${customer.name} (${customer.id})` })),
]

const agentChoices = (model: Model) => [
  { value: "", label: "Choose an agent" },
  ...model.agents.map((agent) => ({ value: agent.id, label: `${agent.name}${agent.onDuty ? "" : " — off duty"}` })),
]

const detailView = (model: Model, h: HtmlBuilder<Message>) => {
  if (model.detail === null) return h.p([], ["Inspect a case to review its event history and advance it."])
  const detail = model.detail

  return h.div([h.Class("stack")], [
    h.p([], [`${detail.customer.name}: ${detail.case.subject}`]),
    h.p([], [`Status ${detail.case.status}; priority ${detail.case.priority}; version ${detail.case.version}.`]),
    h.p([], [`Assigned agent: ${detail.agent?.name ?? "Unassigned"}.`]),
    dataTable(h, {
      caption: "Case event history",
      columns: ["When", "Event", "Agent", "Note"],
      rows: detail.events,
      key: (event) => event.id,
      cells: (event) => [
        DateTime.formatIso(event.occurredAt),
        event.kind,
        event.agentId ?? "—",
        event.note ?? "—",
      ],
    }),
    h.form([h.Class("stack"), h.OnSubmit(Message.ClickedAdvanceCase())], [
      field(h, { id: "transition-action", label: "Next action", children: selectInput(h, { id: "transition-action", value: model.transitionAction, choices: actionChoices, onChange: (value) => Message.ChangedTransitionAction({ value }) }) }),
      field(h, { id: "transition-agent", label: "Agent required for assign", children: selectInput(h, { id: "transition-agent", value: model.transitionAgentId, choices: agentChoices(model), onChange: (value) => Message.ChangedTransitionAgentId({ value }) }) }),
      field(h, { id: "transition-note", label: "Event note", children: textareaInput(h, { id: "transition-note", value: model.transitionNote, rows: 3, onInput: (value) => Message.ChangedTransitionNote({ value }) }) }),
      primaryButton(h, { label: pending(model, "mutation") ? "Advancing…" : "Advance case", message: Option.none(), type: "submit", disabled: pending(model, "mutation") }),
    ]),
  ])
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Support cases",
  body: shell(h, {
    title: "Support cases",
    lede: "Open, triage, assign, resolve, and reopen customer cases. The board is a derived joined projection; the nested event history remains authored SQL.",
    notice: model.notice,
    session: null,
    children: [
      h.div([h.Class("split")], [
        h.section([h.Class("panel stack")], [
          h.h2([], ["Register customer"]),
          h.form([h.Class("stack"), h.OnSubmit(Message.ClickedCreateCustomer())], [
            field(h, { id: "customer-id", label: "Customer ID", children: textInput(h, { id: "customer-id", value: model.customerId, type: "text", placeholder: "acme", autocomplete: "off", onInput: (value) => Message.ChangedCustomerId({ value }) }) }),
            field(h, { id: "customer-name", label: "Customer name", children: textInput(h, { id: "customer-name", value: model.customerName, type: "text", placeholder: "Acme Industries", autocomplete: "off", onInput: (value) => Message.ChangedCustomerName({ value }) }) }),
            primaryButton(h, { label: "Create customer", message: Option.none(), type: "submit", disabled: pending(model, "mutation") }),
          ]),
        ]),
        h.section([h.Class("panel stack")], [
          h.h2([], ["Register agent"]),
          h.form([h.Class("stack"), h.OnSubmit(Message.ClickedCreateAgent())], [
            field(h, { id: "agent-id", label: "Agent ID", children: textInput(h, { id: "agent-id", value: model.agentId, type: "text", placeholder: "sam", autocomplete: "off", onInput: (value) => Message.ChangedAgentId({ value }) }) }),
            field(h, { id: "agent-name", label: "Agent name", children: textInput(h, { id: "agent-name", value: model.agentName, type: "text", placeholder: "Sam", autocomplete: "off", onInput: (value) => Message.ChangedAgentName({ value }) }) }),
            field(h, { id: "agent-duty", label: "Duty", children: selectInput(h, { id: "agent-duty", value: String(model.agentOnDuty), choices: dutyChoices, onChange: (value) => Message.ChangedAgentOnDuty({ value }) }) }),
            primaryButton(h, { label: "Create agent", message: Option.none(), type: "submit", disabled: pending(model, "mutation") }),
          ]),
        ]),
      ]),
      h.section([h.Class("panel stack")], [
        h.h2([], ["Open case"]),
        h.form([h.Class("split"), h.OnSubmit(Message.ClickedOpenCase())], [
          field(h, { id: "case-customer", label: "Customer", children: selectInput(h, { id: "case-customer", value: model.caseCustomerId, choices: customerChoices(model), onChange: (value) => Message.ChangedCaseCustomerId({ value }) }) }),
          field(h, { id: "case-priority", label: "Priority", children: selectInput(h, { id: "case-priority", value: model.casePriority, choices: priorityChoices, onChange: (value) => Message.ChangedCasePriority({ value }) }) }),
          field(h, { id: "case-subject", label: "Subject", children: textInput(h, { id: "case-subject", value: model.caseSubject, type: "text", placeholder: "Cannot export quarterly report", autocomplete: "off", onInput: (value) => Message.ChangedCaseSubject({ value }) }) }),
          primaryButton(h, { label: "Open case", message: Option.none(), type: "submit", disabled: pending(model, "mutation") }),
        ]),
      ]),
      h.section([h.Class("panel stack")], [
        h.div([h.Class("actions")], [
          h.h2([], ["Case board"]),
          selectInput(h, { id: "board-status", value: model.filterStatus, choices: filterStatusChoices, onChange: (value) => Message.ChangedFilterStatus({ value }) }),
          quietButton(h, { label: pending(model, "board") ? "Loading…" : "Reload", message: Message.ClickedReload(), disabled: pending(model, "board") }),
        ]),
        dataTable(h, {
          caption: "Current support cases",
          columns: ["Opened", "Customer", "Subject", "Priority", "Status", "Agent", "Version", ""],
          rows: model.board,
          key: (row) => row.id,
          cells: (row) => [
            DateTime.formatIso(row.openedAt),
            row.customerName,
            row.subject,
            row.priority,
            row.status,
            row.agentName ?? "—",
            String(row.version),
            quietButton(h, { label: "Inspect", message: Message.ClickedInspectCase({ id: row.id }), disabled: pending(model, "detail") }),
          ],
        }),
      ]),
      h.section([h.Class("panel stack")], [
        h.h2([], ["Case detail"]),
        detailView(model, h),
      ]),
    ],
  }),
})
