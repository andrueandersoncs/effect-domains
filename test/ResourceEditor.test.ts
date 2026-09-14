import { expect, it } from "@effect/vitest"
import { Array, Option, Record, Schema, Struct, pipe } from "effect"
import { Authorization } from "effect-domains/authorization"
import { Form } from "effect-domains/form"
import { RequestTokenSchema } from "effect-domains/requests"
import { Resource } from "effect-domains/resource"
import { ResourceEditor } from "effect-domains/resource-editor"

const TodoSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  priority: Schema.Int,
})

const todoCapabilities = Resource.crud()

const Todos = Resource.define({
  name: "resource_editor_todos",
  schema: TodoSchema,
  authorization: Authorization.public,
  capabilities: todoCapabilities,
})

const TodosRuntime = Resource.compile(Todos)

const TodoFormSchema = Schema.Struct({
  title: Form.text(TodoSchema.fields.title),
  priority: Form.integer(TodoSchema.fields.priority),
})

const Editor = ResourceEditor.make({
  name: "test/TodoEditor",
  resource: TodosRuntime,
  form: TodoFormSchema,
  empty: { title: "", priority: "0" },
  notices: {
    created: "Todo created.",
    updated: "Todo updated.",
    removed: "Todo removed.",
  },
  formatError: String,
})

const todoId = "018f2520-1468-7e56-9f89-1b2d3c4e5f60"

it("resource editor consumes synchronized pages and settles mutations", () => {
  const initialized = Editor.init()

  expect(initialized.model).toMatchObject({
    items: [],
    nextCursor: null,
    form: { title: "", priority: "0" },
    selectedId: null,
    fieldErrors: {},
    notice: null,
  })

  const initialCommands = initialized.commands ?? []
  const initialCommandNames = Array.map(initialCommands, Struct.get("name"))

  expect(initialCommandNames).toEqual([])

  const loadedMessage = Editor.Message.SynchronizedList({
    page: { items: [{ id: todoId, title: "Ship", priority: 2 }], nextCursor: "next" },
  })

  const loaded = Editor.update(initialized.model, loadedMessage)
  const selectMessage = Editor.Message.ClickedSelect({ id: todoId })
  const selected = Editor.update(loaded.model, selectMessage)

  expect(selected.model.form).toEqual({ title: "Ship", priority: "2" })
  expect(selected.model.selectedId).toBe(todoId)

  const changeMessage = Editor.Message.ChangedField({ key: "title", value: "" })
  const edited = Editor.update(selected.model, changeMessage)
  const saveMessage = Editor.Message.ClickedSave()
  const saving = Editor.update(edited.model, saveMessage)
  const saveCommands = saving.commands ?? []
  const saveCommandNames = Array.map(saveCommands, Struct.get("name"))

  expect(saveCommandNames).toEqual(["test/TodoEditor.Save"])
  expect(saving.model.fieldErrors).toEqual({})

  const pendingSaveIds = Record.values(saving.model.requests.pending)
  const saveRequestId = pipe(pendingSaveIds, Option.fromIterable, Option.getOrThrow)

  const saveRequest = RequestTokenSchema.make({
    epoch: saving.model.requests.epoch,
    id: saveRequestId,
    key: "resource_editor_todos.save",
  })

  const savedMessage = Editor.Message.SucceededSave({
    row: { id: todoId, title: "Ship", priority: 3 },
    created: false,
    request: saveRequest,
  })

  const saved = Editor.update(saving.model, savedMessage)

  expect(saved.model.form).toEqual({ title: "Ship", priority: "3" })
  expect(saved.model.notice).toEqual({ kind: "success", text: "Todo updated." })

  const reloadCommands = saved.commands ?? []
  const reloadCommandNames = Array.map(reloadCommands, Struct.get("name"))

  expect(reloadCommandNames).toEqual([])
})

it("resource editor preserves newer form edits when a save completes", () => {
  const initialized = Editor.init()

  const listedMessage = Editor.Message.SynchronizedList({
    page: { items: [{ id: todoId, title: "Before", priority: 1 }], nextCursor: null },
  })

  const loaded = Editor.update(initialized.model, listedMessage)
  const selectMessage = Editor.Message.ClickedSelect({ id: todoId })
  const selected = Editor.update(loaded.model, selectMessage)
  const saveMessage = Editor.Message.ClickedSave()
  const saving = Editor.update(selected.model, saveMessage)

  const saveRequestId = pipe(
    Record.get(saving.model.requests.pending, "resource_editor_todos.save"),
    Option.getOrThrow,
  )

  const saveRequest = RequestTokenSchema.make({
    epoch: saving.model.requests.epoch,
    id: saveRequestId,
    key: "resource_editor_todos.save",
  })

  const editMessage = Editor.Message.ChangedField({ key: "title", value: "Next edit" })
  const edited = Editor.update(saving.model, editMessage)

  const completedMessage = Editor.Message.SucceededSave({
    row: { id: todoId, title: "Before", priority: 1 },
    created: false,
    request: saveRequest,
  })

  const completed = Editor.update(edited.model, completedMessage)
  const completedSavePending = Editor.pending(completed.model, "save")
  const completedCommands = Array.map(completed.commands ?? [], Struct.get("name"))

  expect(completed.model.form).toEqual({ title: "Next edit", priority: "1" })
  expect(completed.model.selectedId).toBe(todoId)
  expect(completed.model.notice).toEqual({ kind: "success", text: "Todo updated." })
  expect(completedSavePending).toBe(false)
  expect(completedCommands).toEqual([])

  const resaveMessage = Editor.Message.ClickedSave()
  const resaving = Editor.update(completed.model, resaveMessage)

  const nextSaveRequestId = pipe(
    Record.get(resaving.model.requests.pending, "resource_editor_todos.save"),
    Option.getOrThrow,
  )

  const nextSaveRequest = RequestTokenSchema.make({
    epoch: resaving.model.requests.epoch,
    id: nextSaveRequestId,
    key: "resource_editor_todos.save",
  })

  const nextEditMessage = Editor.Message.ChangedField({ key: "title", value: "Third edit" })
  const editedAgain = Editor.update(resaving.model, nextEditMessage)

  const failedMessage = Editor.Message.Failed({
    request: nextSaveRequest,
    error: "The superseded save failed.",
    fieldErrors: { title: "The superseded save failed." },
  })

  const failed = Editor.update(editedAgain.model, failedMessage)
  const failedSavePending = Editor.pending(failed.model, "save")

  expect(failed.model.form).toEqual({ title: "Third edit", priority: "1" })
  expect(failed.model.fieldErrors).toEqual({})
  expect(failed.model.notice).toBeNull()
  expect(failedSavePending).toBe(false)
})

it("resource editor enqueues each mutation at most once while it is pending", () => {
  const initialized = Editor.init()
  const clickedSave = Editor.Message.ClickedSave()
  const firstSave = Editor.update(initialized.model, clickedSave)
  const duplicateSave = Editor.update(firstSave.model, clickedSave)
  const clickedRemove = Editor.Message.ClickedRemove({ id: todoId })
  const firstRemove = Editor.update(initialized.model, clickedRemove)
  const duplicateRemove = Editor.update(firstRemove.model, clickedRemove)

  expect(duplicateSave.commands).toBeUndefined()
  expect(duplicateSave.model.requests).toEqual(firstSave.model.requests)
  expect(duplicateRemove.commands).toBeUndefined()
  expect(duplicateRemove.model.requests).toEqual(firstRemove.model.requests)
})
