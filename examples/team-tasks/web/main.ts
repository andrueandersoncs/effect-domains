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
import { rpcCall } from "@effect-domains/example-web/rpc"
import { TaskPrioritySchema, TaskSchema } from "../domain.ts"

const TaskRowSchema = Schema.Struct({
  id: Schema.String,
  project: TaskSchema.fields.project,
  title: TaskSchema.fields.title,
  detail: TaskSchema.fields.detail,
  priority: TaskPrioritySchema,
  dueDate: TaskSchema.fields.dueDate,
  completed: TaskSchema.fields.completed,
  tenantId: TaskSchema.fields.tenantId,
  ownerId: TaskSchema.fields.ownerId,
})

const cursorFromUnknown = (value: unknown) => {
  if (value === null || value === undefined) return null
  if (typeof value === "string" && value.length > 0) return value
  if (typeof value === "object" && value !== null && "_tag" in value) {
    const tagged = value as { _tag: unknown; value?: unknown }
    if (tagged._tag === "Some" && typeof tagged.value === "string") return tagged.value
  }
  return null
}

const TaskPageSchema = Schema.Struct({
  items: Schema.Array(TaskRowSchema),
  nextCursor: Schema.Unknown,
})

const priorities = ["low", "normal", "high", "urgent"] as const
const priorityChoices = [
  { value: "", label: "Any priority" },
  ...Array.map(priorities, (priority) => ({ value: priority, label: priority })),
]
const formPriorityChoices = Array.map(priorities, (priority) => ({ value: priority, label: priority }))
const completedChoices = [
  { value: "", label: "Any completion state" },
  { value: "false", label: "Open" },
  { value: "true", label: "Completed" },
]
const formCompletedChoices = [
  { value: "false", label: "Open" },
  { value: "true", label: "Completed" },
]

export const Model = Schema.Struct({
  token: Schema.String,
  requestId: Schema.Number,
  todos: Schema.Array(TaskRowSchema),
  nextCursor: Schema.NullOr(Schema.String),
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
  busy: Schema.Boolean,
  notice: Schema.NullOr(Schema.Struct({
    kind: Schema.Literals(["info", "error", "success"]),
    text: Schema.String,
  })),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ChangedSession: { value: Schema.String },
  SelectedSession: { token: Schema.String },
  ChangedFilterProject: { value: Schema.String },
  ChangedFilterPriority: { value: Schema.String },
  ChangedFilterCompleted: { value: Schema.String },
  ChangedProject: { value: Schema.String },
  ChangedTitle: { value: Schema.String },
  ChangedDetail: { value: Schema.String },
  ChangedPriority: { value: Schema.String },
  ChangedDueDate: { value: Schema.String },
  ChangedCompleted: { value: Schema.String },
  ClickedReload: {},
  ClickedSave: {},
  ClickedNew: {},
  ClickedSelect: { id: Schema.String },
  ClickedRemove: { id: Schema.String },
  SucceededList: { requestId: Schema.Number, items: Schema.Array(TaskRowSchema), nextCursor: Schema.NullOr(Schema.String) },
  SucceededSave: { todo: TaskRowSchema, created: Schema.Boolean },
  SucceededRemove: { id: Schema.String },
  Failed: { error: Schema.String },
})
export type Message = typeof Message.Type

type UpdateReturn = Update.Return<Model, Message>

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

export const ListTasks = Command.define("ListTasks", {
  args: {
    token: Schema.String,
    requestId: Schema.Number,
    filterProject: Schema.String,
    filterPriority: Schema.String,
    filterCompleted: Schema.String,
  },
  messages: [Message.SucceededList, Message.Failed],
  execute: ({ token, requestId, filterProject, filterPriority, filterCompleted }) =>
    pipe(
      rpcCall({
        tag: "todos.list",
        payload: {
          filter: {
            ...(filterProject === "" ? {} : { project: filterProject }),
            ...(filterPriority === "" ? {} : { priority: filterPriority }),
            ...(filterCompleted === "" ? {} : { completed: filterCompleted === "true" }),
          },
          limit: 25,
        },
        token,
        success: TaskPageSchema,
      }),
      Effect.match({
        onSuccess: (page) => Message.SucceededList({
          requestId,
          items: page.items,
          nextCursor: cursorFromUnknown(page.nextCursor),
        }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

export const SaveTask = Command.define("SaveTask", {
  args: {
    token: Schema.String,
    selectedId: Schema.NullOr(Schema.String),
    project: Schema.String,
    title: Schema.String,
    detail: Schema.String,
    priority: TaskPrioritySchema,
    dueDate: Schema.String,
    completed: Schema.Boolean,
    tenantId: Schema.String,
    ownerId: Schema.String,
  },
  messages: [Message.SucceededSave, Message.Failed],
  execute: (args) => {
    const creating = args.selectedId === null
    const todo = {
      project: args.project.trim(),
      title: args.title.trim(),
      detail: args.detail.trim() === "" ? null : args.detail.trim(),
      priority: args.priority,
      dueDate: args.dueDate.trim() === "" ? null : args.dueDate.trim(),
    }
    return pipe(
      rpcCall({
        tag: creating ? "todos.create" : "todos.update",
        payload: creating
          ? todo
          : {
            id: args.selectedId,
            ...todo,
            completed: args.completed,
            tenantId: args.tenantId,
            ownerId: args.ownerId,
          },
        token: args.token,
        success: TaskRowSchema,
      }),
      Effect.match({
        onSuccess: (saved) => Message.SucceededSave({ todo: saved, created: creating }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    )
  },
})

export const RemoveTask = Command.define("RemoveTask", {
  args: { token: Schema.String, id: Schema.String },
  messages: [Message.SucceededRemove, Message.Failed],
  execute: ({ token, id }) =>
    pipe(
      rpcCall({
        tag: "todos.remove",
        payload: { id },
        token,
        success: Schema.Unknown,
      }),
      Effect.match({
        onSuccess: () => Message.SucceededRemove({ id }),
        onFailure: (error) => Message.Failed({ error: error.message }),
      }),
    ),
})

const reload = (model: Model) => ListTasks({
  token: model.token,
  requestId: model.requestId,
  filterProject: model.filterProject,
  filterPriority: model.filterPriority,
  filterCompleted: model.filterCompleted,
})

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ChangedSession: ({ value }) => ({
      model: evo(model, {
        token: () => value,
        requestId: () => model.requestId + 1,
        todos: () => [],
        nextCursor: () => null,
        selectedId: () => null,
        project: () => "",
        title: () => "",
        detail: () => "",
        priority: () => "normal",
        dueDate: () => "",
        completed: () => false,
        tenantId: () => "",
        ownerId: () => "",
        busy: () => false,
        notice: () => null,
      }),
    }),
    SelectedSession: ({ token }) => {
      const next = evo(model, {
        token: () => token,
        requestId: () => model.requestId + 1,
        todos: () => [],
        nextCursor: () => null,
        selectedId: () => null,
        project: () => "",
        title: () => "",
        detail: () => "",
        priority: () => "normal",
        dueDate: () => "",
        completed: () => false,
        tenantId: () => "",
        ownerId: () => "",
        busy: () => true,
        notice: () => null,
      })
      return { model: next, commands: [reload(next)] }
    },
    ChangedFilterProject: ({ value }) => {
      const next = evo(model, { filterProject: () => value, requestId: () => model.requestId + 1, busy: () => true })
      return { model: next, commands: [reload(next)] }
    },
    ChangedFilterPriority: ({ value }) => {
      const next = evo(model, { filterPriority: () => value, requestId: () => model.requestId + 1, busy: () => true })
      return { model: next, commands: [reload(next)] }
    },
    ChangedFilterCompleted: ({ value }) => {
      const next = evo(model, { filterCompleted: () => value, requestId: () => model.requestId + 1, busy: () => true })
      return { model: next, commands: [reload(next)] }
    },
    ChangedProject: ({ value }) => ({ model: evo(model, { project: () => value }) }),
    ChangedTitle: ({ value }) => ({ model: evo(model, { title: () => value }) }),
    ChangedDetail: ({ value }) => ({ model: evo(model, { detail: () => value }) }),
    ChangedPriority: ({ value }) => ({ model: evo(model, { priority: () => value as Model["priority"] }) }),
    ChangedDueDate: ({ value }) => ({ model: evo(model, { dueDate: () => value }) }),
    ChangedCompleted: ({ value }) => ({ model: evo(model, { completed: () => value === "true" }) }),
    ClickedReload: () => {
      const next = evo(model, { requestId: () => model.requestId + 1, busy: () => true })
      return { model: next, commands: [reload(next)] }
    },
    ClickedSave: () => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [SaveTask({
        token: model.token,
        selectedId: model.selectedId,
        project: model.project,
        title: model.title,
        detail: model.detail,
        priority: model.priority,
        dueDate: model.dueDate,
        completed: model.completed,
        tenantId: model.tenantId,
        ownerId: model.ownerId,
      })],
    }),
    ClickedNew: () => ({
      model: evo(model, {
        selectedId: () => null,
        project: () => "",
        title: () => "",
        detail: () => "",
        priority: () => "normal",
        dueDate: () => "",
        completed: () => false,
        tenantId: () => "",
        ownerId: () => "",
      }),
    }),
    ClickedSelect: ({ id }) =>
      Option.match(Array.findFirst(model.todos, (item) => item.id === id), {
        onNone: () => ({ model }),
        onSome: (todo) => ({
          model: evo(model, {
            selectedId: () => todo.id,
            project: () => todo.project,
            title: () => todo.title,
            detail: () => todo.detail ?? "",
            priority: () => todo.priority,
            dueDate: () => todo.dueDate ?? "",
            completed: () => todo.completed,
            tenantId: () => todo.tenantId,
            ownerId: () => todo.ownerId,
            notice: () => null,
          }),
        }),
      }),
    ClickedRemove: ({ id }) => ({
      model: evo(model, { busy: () => true, notice: () => null }),
      commands: [RemoveTask({ token: model.token, id })],
    }),
    SucceededList: ({ requestId, items, nextCursor }) =>
      requestId === model.requestId
        ? { model: evo(model, { todos: () => items, nextCursor: () => nextCursor, busy: () => false }) }
        : { model },
    SucceededSave: ({ todo, created }) => {
      const next = evo(model, {
        requestId: () => model.requestId + 1,
        selectedId: () => todo.id,
        project: () => todo.project,
        title: () => todo.title,
        detail: () => todo.detail ?? "",
        priority: () => todo.priority,
        dueDate: () => todo.dueDate ?? "",
        completed: () => todo.completed,
        tenantId: () => todo.tenantId,
        ownerId: () => todo.ownerId,
        busy: () => true,
        notice: () => ({ kind: "success" as const, text: created ? "Task created." : "Task updated." }),
      })
      return { model: next, commands: [reload(next)] }
    },
    SucceededRemove: ({ id }) => {
      const next = evo(model, {
        requestId: () => model.requestId + 1,
        selectedId: () => model.selectedId === id ? null : model.selectedId,
        project: () => model.selectedId === id ? "" : model.project,
        title: () => model.selectedId === id ? "" : model.title,
        detail: () => model.selectedId === id ? "" : model.detail,
        priority: () => model.selectedId === id ? "normal" : model.priority,
        dueDate: () => model.selectedId === id ? "" : model.dueDate,
        completed: () => model.selectedId === id ? false : model.completed,
        tenantId: () => model.selectedId === id ? "" : model.tenantId,
        ownerId: () => model.selectedId === id ? "" : model.ownerId,
        busy: () => true,
        notice: () => ({ kind: "success" as const, text: "Task removed." }),
      })
      return { model: next, commands: [reload(next)] }
    },
    Failed: ({ error }) => ({
      model: evo(model, { busy: () => false, notice: () => ({ kind: "error" as const, text: error }) }),
    }),
  })

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    token: "alice-demo",
    requestId: 0,
    todos: [],
    nextCursor: null,
    filterProject: "",
    filterPriority: "",
    filterCompleted: "",
    ...emptyForm,
    busy: true,
    notice: null,
  },
  commands: [ListTasks({ token: "alice-demo", requestId: 0, filterProject: "", filterPriority: "", filterCompleted: "" })],
})

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Team tasks",
  body: shell(h, {
    title: "Team tasks",
    lede: "Organize work for your team and track what is ready to close.",
    notice: model.notice,
    session: {
      token: model.token,
      onInput: (value) => Message.ChangedSession({ value }),
      onSelect: (token) => Message.SelectedSession({ token }),
    },
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
                    id: "filter-project",
                    label: "Project",
                    children: textInput(h, {
                      id: "filter-project",
                      value: model.filterProject,
                      onInput: (value) => Message.ChangedFilterProject({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "filter-priority",
                    label: "Priority",
                    children: selectInput(h, {
                      id: "filter-priority",
                      value: model.filterPriority,
                      onChange: (value) => Message.ChangedFilterPriority({ value }),
                      choices: priorityChoices,
                    }),
                  }),
                  field(h, {
                    id: "filter-completed",
                    label: "Status",
                    children: selectInput(h, {
                      id: "filter-completed",
                      value: model.filterCompleted,
                      onChange: (value) => Message.ChangedFilterCompleted({ value }),
                      choices: completedChoices,
                    }),
                  }),
                  primaryButton(h, {
                    label: model.busy ? "Loading…" : "Reload",
                    message: Option.some(Message.ClickedReload()),
                    type: "button",
                    disabled: model.busy,
                  }),
                ],
              ),
              dataTable(h, {
                caption: "Tasks",
                columns: ["Project", "Task", "Priority", "Due", "Status", ""],
                rows: model.todos,
                key: (todo) => todo.id,
                cells: (todo) => [
                  todo.project,
                  todo.title,
                  todo.priority,
                  todo.dueDate ?? "—",
                  todo.completed ? "Completed" : "Open",
                  h.div(
                    [h.Class("row-actions")],
                    [
                      quietButton(h, { label: "Edit", message: Message.ClickedSelect({ id: todo.id }), disabled: false }),
                      quietButton(h, { label: "Remove", message: Message.ClickedRemove({ id: todo.id }), disabled: model.busy }),
                    ],
                  ),
                ],
              }),
            ],
          ),
          h.section(
            [h.Class("panel")],
            [
              h.form(
                [h.Class("stack"), h.OnSubmit(Message.ClickedSave())],
                [
                  h.h2([], [model.selectedId === null ? "Create task" : "Edit task"]),
                  field(h, {
                    id: "project",
                    label: "Project",
                    children: textInput(h, {
                      id: "project",
                      value: model.project,
                      onInput: (value) => Message.ChangedProject({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "title",
                    label: "Title",
                    children: textInput(h, {
                      id: "title",
                      value: model.title,
                      onInput: (value) => Message.ChangedTitle({ value }),
                      type: "text",
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  field(h, {
                    id: "detail",
                    label: "Detail",
                    children: textareaInput(h, {
                      id: "detail",
                      value: model.detail,
                      rows: 4,
                      onInput: (value) => Message.ChangedDetail({ value }),
                    }),
                  }),
                  field(h, {
                    id: "priority",
                    label: "Priority",
                    children: selectInput(h, {
                      id: "priority",
                      value: model.priority,
                      onChange: (value) => Message.ChangedPriority({ value }),
                      choices: formPriorityChoices,
                    }),
                  }),
                  field(h, {
                    id: "due-date",
                    label: "Due date",
                    children: textInput(h, {
                      id: "due-date",
                      type: "date",
                      value: model.dueDate,
                      onInput: (value) => Message.ChangedDueDate({ value }),
                      placeholder: "",
                      autocomplete: "off",
                    }),
                  }),
                  ...(model.selectedId === null ? [] : [field(h, {
                    id: "completed",
                    label: "Status",
                    children: selectInput(h, {
                      id: "completed",
                      value: String(model.completed),
                      onChange: (value) => Message.ChangedCompleted({ value }),
                      choices: formCompletedChoices,
                    }),
                  })]),
                  h.div(
                    [h.Class("actions")],
                    [
                      primaryButton(h, {
                        label: model.selectedId === null ? "Create task" : "Save changes",
                        message: Option.none(),
                        type: "submit",
                        disabled: model.busy,
                      }),
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
