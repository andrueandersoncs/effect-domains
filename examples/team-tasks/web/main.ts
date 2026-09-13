import { Array, Effect, Option, Schema, pipe } from "effect"
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
import { BrowserModel } from "effect-domains/browser-model"
import { Page } from "effect-domains/page"
import { ResourcePager } from "effect-domains/resource-pager"
import { RpcBrowser } from "effect-domains/rpc-browser"
import { Requests, RequestStateSchema, RequestTokenSchema } from "effect-domains/requests"
import { identitySessionView } from "@effect-domains/example-web/session"
import { IdentitySession as Session } from "effect-domains/identity-session"

import { IdentityRpcs } from "effect-domains/identity-rpc"
import { RpcService, type Type } from "effect-domains/rpc-service"
import { TaskPrioritySchema, TaskSchema } from "../domain.ts"
import { TasksResource } from "../resources.ts"

type SessionClient = Type<typeof Session.Client>

const TeamTasksRpcs = IdentityRpcs.merge(TasksResource.group)
const TaskRowSchema = TasksResource.table.rowSchema
const TaskPageSchema = TasksResource.contracts.list.successSchema
type TaskRow = typeof TaskRowSchema.Type

export const WebClient = RpcService.make({ name: "team-tasks/WebClient", group: TeamTasksRpcs })
export type WebClient = Type<typeof WebClient>

const priorities = ["low", "normal", "high", "urgent"] as const
const priorityChoices = [{ value: "", label: "Any priority" }, ...Array.map(priorities, (value) => ({ value, label: value }))]
const completedChoices = [
  { value: "", label: "Any completion state" },
  { value: "false", label: "Open" },
  { value: "true", label: "Completed" },
]

export const Model = Schema.Struct({
  session: Session.ModelSchema,
  requests: RequestStateSchema,
  tasks: TaskPageSchema,
  filterProject: Schema.String,
  filterPriority: Schema.String,
  filterCompleted: Schema.String,
  selectedId: Schema.NullOr(Schema.String),
  project: Schema.String,
  title: Schema.String,
  detail: Schema.String,
  priority: TaskPrioritySchema,
  dueDate: Schema.String,
  completed: Schema.Boolean,
  tenantId: Schema.String,
  ownerId: Schema.String,
  notice: BrowserModel.NoticeSchema,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  SessionChanged: { message: Session.MessageSchema },
  ChangedFilterProject: { value: Schema.String },
  ChangedFilterPriority: { value: Schema.String },
  ChangedFilterCompleted: { value: Schema.String },
  ChangedProject: { value: Schema.String },
  ChangedTitle: { value: Schema.String },
  ChangedDetail: { value: Schema.String },
  ChangedPriority: { value: TaskPrioritySchema },
  ChangedDueDate: { value: Schema.String },
  ChangedCompleted: { value: Schema.Boolean },
  ClickedReload: {},
  ClickedMore: {},
  ClickedSave: {},
  ClickedNew: {},
  ClickedSelect: { id: Schema.String },
  ClickedRemove: { id: Schema.String },
  SucceededList: { request: RequestTokenSchema, append: Schema.Boolean, page: TaskPageSchema },
  SucceededSave: { request: RequestTokenSchema, task: TaskRowSchema, created: Schema.Boolean },
  SucceededRemove: { request: RequestTokenSchema, id: Schema.String },
  Failed: { request: RequestTokenSchema, error: Schema.String },
})
export type Message = typeof Message.Type
type UpdateReturn = Update.Return<Model, Message, WebClient | SessionClient>

const emptyForm = {
  selectedId: null as string | null,
  project: "",
  title: "",
  detail: "",
  priority: "normal" as const,
  dueDate: "",
  completed: false,
  tenantId: "",
  ownerId: "",
}

const taskInput = (model: Model) => ({
  project: model.project.trim(),
  title: model.title.trim(),
  detail: model.detail.trim() === "" ? null : model.detail.trim(),
  priority: model.priority,
  dueDate: model.dueDate.trim() === "" ? null : model.dueDate.trim(),
})

export const ListTasks = Command.define("ListTasks", {
  args: {
    request: RequestTokenSchema,
    token: Schema.String,
    filterProject: Schema.String,
    filterPriority: Schema.String,
    filterCompleted: Schema.String,
    cursor: Schema.NullOr(Schema.String),
    append: Schema.Boolean,
  },
  messages: [Message.SucceededList, Message.Failed],
  execute: ({ request, token, filterProject, filterPriority, filterCompleted, cursor, append }) =>
    pipe(
      Effect.gen(function*() {
        const client = yield* WebClient
        return yield* client["todos.list"]({
          filter: {
            ...(filterProject === "" ? {} : { project: filterProject }),
            ...(filterPriority === "" ? {} : { priority: filterPriority }),
            ...(filterCompleted === "" ? {} : { completed: filterCompleted === "true" }),
          },
          limit: 25,
          ...Page.input(cursor),
        }, RpcBrowser.requestOptions(token))
      }),
      Effect.match({
        onSuccess: (page) => Message.SucceededList({ request, append, page }),
        onFailure: (error) => Message.Failed({ request, error: RpcBrowser.messageFromUnknown(error) }),
      }),
    ),
})

export const SaveTask = Command.define("SaveTask", {
  args: { request: RequestTokenSchema, token: Schema.String, selectedId: Schema.NullOr(Schema.String), task: TaskSchema },
  messages: [Message.SucceededSave, Message.Failed],
  execute: ({ request, token, selectedId, task }) =>
    pipe(
      Effect.gen(function*() {
        const client = yield* WebClient
        return selectedId === null
          ? yield* client["todos.create"]({
            project: task.project,
            title: task.title,
            detail: task.detail,
            priority: task.priority,
            dueDate: task.dueDate,
          }, RpcBrowser.requestOptions(token))
          : yield* client["todos.update"]({ id: selectedId, ...task }, RpcBrowser.requestOptions(token))
      }),
      Effect.match({
        onSuccess: (task) => Message.SucceededSave({ request, task, created: selectedId === null }),
        onFailure: (error) => Message.Failed({ request, error: RpcBrowser.messageFromUnknown(error) }),
      }),
    ),
})

export const RemoveTask = Command.define("RemoveTask", {
  args: { request: RequestTokenSchema, token: Schema.String, id: Schema.String },
  messages: [Message.SucceededRemove, Message.Failed],
  execute: ({ request, token, id }) =>
    pipe(
      Effect.gen(function*() {
        const client = yield* WebClient
        yield* client["todos.remove"]({ id }, RpcBrowser.requestOptions(token))
      }),
      Effect.match({
        onSuccess: () => Message.SucceededRemove({ request, id }),
        onFailure: (error) => Message.Failed({ request, error: RpcBrowser.messageFromUnknown(error) }),
      }),
    ),
})

const TasksPager = ResourcePager.make("tasks.list")
const tasksState = (model: Model) => ({ page: model.tasks, requests: model.requests })
const beginList = (model: Model, append: boolean) => {
  const token = Session.token(model.session)
  if (token === null) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Sign in before listing tasks." }) }), commands: [] }
  const started = pipe(TasksPager.begin(model.requests, model.tasks, append), Option.getOrThrow)
  return {
    model: evo(model, {
      requests: () => started.requests,
      tasks: () => started.page,
      notice: () => null,
    }),
    commands: [ListTasks({
      request: started.request,
      token,
      filterProject: model.filterProject,
      filterPriority: model.filterPriority,
      filterCompleted: model.filterCompleted,
      cursor: started.cursor,
      append: started.append,
    })],
  }
}

const resetIdentity = (model: Model, session: typeof Session.ModelSchema.Type): Model => {
  const reset = TasksPager.reset(tasksState(model))
  return {
    ...model,
    ...emptyForm,
    session,
    requests: reset.requests,
    tasks: reset.page,
    filterProject: "",
    filterPriority: "",
    filterCompleted: "",
    notice: null,
  }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SessionChanged: ({ message }) => {
      const child = Session.embed(model.session, message, (message) => Message.SessionChanged({ message }))
      const changed = Session.generationChanged(model.session, child.model)
      const next = changed ? resetIdentity(model, child.model) : evo(model, { session: () => child.model })
      if (!changed || child.model.token === null) return { model: next, commands: child.commands }
      const listing = beginList(next, false)
      return { model: listing.model, commands: [...child.commands, ...listing.commands] }
    },
    ChangedFilterProject: ({ value }) => beginList(evo(model, { filterProject: () => value }), false),
    ChangedFilterPriority: ({ value }) => beginList(evo(model, { filterPriority: () => value }), false),
    ChangedFilterCompleted: ({ value }) => beginList(evo(model, { filterCompleted: () => value }), false),
    ChangedProject: ({ value }) => ({ model: evo(model, { project: () => value }) }),
    ChangedTitle: ({ value }) => ({ model: evo(model, { title: () => value }) }),
    ChangedDetail: ({ value }) => ({ model: evo(model, { detail: () => value }) }),
    ChangedPriority: ({ value }) => ({ model: evo(model, { priority: () => value }) }),
    ChangedDueDate: ({ value }) => ({ model: evo(model, { dueDate: () => value }) }),
    ChangedCompleted: ({ value }) => ({ model: evo(model, { completed: () => value }) }),
    ClickedReload: () => beginList(model, false),
    ClickedMore: () => model.tasks.nextCursor === null || TasksPager.pending(model.requests) ? { model } : beginList(model, true),
    ClickedSave: () => {
      const token = Session.token(model.session)
      if (token === null) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Sign in before saving a task." }) }) }
      if (model.project.trim() === "" || model.title.trim() === "") {
        return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Project and title are required." }) }) }
      }
      const started = Requests.start(model.requests, "tasks.save")
      const base = taskInput(model)
      const task = {
        completed: model.selectedId === null ? false : model.completed,
        tenantId: model.tenantId,
        ownerId: model.ownerId,
        ...base,
      }
      return {
        model: evo(model, { requests: () => started.state, notice: () => null }),
        commands: [SaveTask({ request: started.request, token, selectedId: model.selectedId, task })],
      }
    },
    ClickedNew: () => ({ model: { ...model, ...emptyForm, requests: Requests.invalidate(model.requests, "tasks.save"), notice: null } }),
    ClickedSelect: ({ id }) => Option.match(Array.findFirst(model.tasks.items, (task) => task.id === id), {
      onNone: () => ({ model }),
      onSome: (task) => ({
        model: evo(model, {
          requests: () => Requests.invalidate(model.requests, "tasks.save"),
          selectedId: () => task.id, project: () => task.project, title: () => task.title,
          detail: () => task.detail ?? "", priority: () => task.priority, dueDate: () => task.dueDate ?? "",
          completed: () => task.completed, tenantId: () => task.tenantId, ownerId: () => task.ownerId, notice: () => null,
        }),
      }),
    }),
    ClickedRemove: ({ id }) => {
      const token = Session.token(model.session)
      if (token === null) return { model: evo(model, { notice: () => ({ kind: "error" as const, text: "Sign in before removing a task." }) }) }
      const started = Requests.start(model.requests, "tasks.remove")
      return { model: evo(model, { requests: () => started.state, notice: () => null }), commands: [RemoveTask({ request: started.request, token, id })] }
    },
    SucceededList: ({ request, append, page }) => Option.match(TasksPager.receive(tasksState(model), request, page, append), {
      onNone: () => ({ model }),
      onSome: (received) => ({ model: evo(model, { requests: () => received.requests, tasks: () => received.page }) }),
    }),
    SucceededSave: ({ request, task, created }) => {
      if (!Requests.accepts(model.requests, request)) return { model }
      const next = evo(model, {
        requests: () => Requests.succeed(model.requests, request),
        selectedId: () => task.id, project: () => task.project, title: () => task.title, detail: () => task.detail ?? "",
        priority: () => task.priority, dueDate: () => task.dueDate ?? "", completed: () => task.completed,
        tenantId: () => task.tenantId, ownerId: () => task.ownerId,
        notice: () => ({ kind: "success" as const, text: created ? "Task created." : "Task updated." }),
      })
      return beginList(next, false)
    },
    SucceededRemove: ({ request, id }) => {
      if (!Requests.accepts(model.requests, request)) return { model }
      const next = evo(model, {
        requests: () => Requests.succeed(model.requests, request),
        ...(model.selectedId === id ? Object.fromEntries(Object.entries(emptyForm).map(([key, value]) => [key, () => value])) : {}),
        notice: () => ({ kind: "success" as const, text: "Task removed." }),
      })
      return beginList(next, false)
    },
    Failed: ({ request, error }) => !Requests.accepts(model.requests, request)
      ? { model }
      : { model: evo(model, { requests: () => Requests.fail(model.requests, request, error), notice: () => ({ kind: "error" as const, text: error }) }) },
  })

export const init: Runtime.ApplicationInit<Model, Message, void, WebClient | SessionClient> = () => ({
  model: {
    session: Session.empty(),
    requests: Requests.empty(),
    tasks: Page.empty<TaskRow>(),
    filterProject: "",
    filterPriority: "",
    filterCompleted: "",
    ...emptyForm,
    notice: null,
  },
})

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Team tasks",
  body: shell(h, {
    title: "Team tasks",
    lede: "Organize work for your team and track what is ready to close.",
    notice: model.notice,
    session: identitySessionView(h, model.session, (message) => Message.SessionChanged({ message })),
    children: [
      h.div([h.Class("split")], [
        h.section([h.Class("panel stack")], [
          h.div([h.Class("actions")], [
            field(h, { id: "filter-project", label: "Project", children: textInput(h, { id: "filter-project", value: model.filterProject, onInput: (value) => Message.ChangedFilterProject({ value }), type: "text", placeholder: "", autocomplete: "off" }) }),
            field(h, { id: "filter-priority", label: "Priority", children: selectInput(h, { id: "filter-priority", value: model.filterPriority, onChange: (value) => Message.ChangedFilterPriority({ value: value as Model["filterPriority"] }), choices: priorityChoices }) }),
            field(h, { id: "filter-completed", label: "Status", children: selectInput(h, { id: "filter-completed", value: model.filterCompleted, onChange: (value) => Message.ChangedFilterCompleted({ value }), choices: completedChoices }) }),
            primaryButton(h, { label: Requests.pending(model.requests, "tasks.list") ? "Loading…" : "Reload", message: Option.some(Message.ClickedReload()), type: "button", disabled: Requests.pending(model.requests, "tasks.list") }),
          ]),
          dataTable(h, { caption: "Tasks", columns: ["Project", "Task", "Priority", "Due", "Status", ""], rows: model.tasks.items, key: (task) => task.id, cells: (task) => [
            task.project, task.title, task.priority, task.dueDate ?? "—", task.completed ? "Completed" : "Open",
            h.div([h.Class("row-actions")], [
              quietButton(h, { label: "Edit", message: Message.ClickedSelect({ id: task.id }), disabled: false }),
              quietButton(h, { label: "Remove", message: Message.ClickedRemove({ id: task.id }), disabled: Requests.pending(model.requests) }),
            ]),
          ] }),
          model.tasks.nextCursor === null ? h.empty : primaryButton(h, { label: "Load more", message: Option.some(Message.ClickedMore()), type: "button", disabled: Requests.pending(model.requests, "tasks.list") }),
        ]),
        h.section([h.Class("panel")], [
          h.form([h.Class("stack"), h.OnSubmit(Message.ClickedSave())], [
            h.h2([], [model.selectedId === null ? "Create task" : "Edit task"]),
            field(h, { id: "project", label: "Project", children: textInput(h, { id: "project", value: model.project, onInput: (value) => Message.ChangedProject({ value }), type: "text", placeholder: "", autocomplete: "off" }) }),
            field(h, { id: "title", label: "Title", children: textInput(h, { id: "title", value: model.title, onInput: (value) => Message.ChangedTitle({ value }), type: "text", placeholder: "", autocomplete: "off" }) }),
            field(h, { id: "detail", label: "Detail", children: textareaInput(h, { id: "detail", value: model.detail, rows: 4, onInput: (value) => Message.ChangedDetail({ value }) }) }),
            field(h, { id: "priority", label: "Priority", children: selectInput(h, { id: "priority", value: model.priority, onChange: (value) => Message.ChangedPriority({ value: value as Model["priority"] }), choices: Array.map(priorities, (value) => ({ value, label: value })) }) }),
            field(h, { id: "due-date", label: "Due date", children: textInput(h, { id: "due-date", type: "date", value: model.dueDate, onInput: (value) => Message.ChangedDueDate({ value }), placeholder: "", autocomplete: "off" }) }),
            ...(model.selectedId === null ? [] : [field(h, { id: "completed", label: "Status", children: selectInput(h, { id: "completed", value: String(model.completed), onChange: (value) => Message.ChangedCompleted({ value: value === "true" }), choices: completedChoices.slice(1) }) })]),
            h.div([h.Class("actions")], [
              primaryButton(h, { label: model.selectedId === null ? "Create task" : "Save changes", message: Option.none(), type: "submit", disabled: Requests.pending(model.requests) }),
              quietButton(h, { label: "Clear", message: Message.ClickedNew(), disabled: false }),
            ]),
          ]),
        ]),
      ]),
    ],
  }),
})
