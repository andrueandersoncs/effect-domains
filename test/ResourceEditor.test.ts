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

const Todos = Resource.make({
  name: "resource_editor_todos",
  schema: TodoSchema,
  authorization: Authorization.public,
  operations: Resource.crud,
})

const TodoFormSchema = Schema.Struct({
  title: Form.text(TodoSchema.fields.title),
  priority: Form.integer(TodoSchema.fields.priority),
})

const Editor = ResourceEditor.make({
  name: "test/TodoEditor",
  resource: Todos,
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

it("resource editor owns form conversion, stale replies, and mutation reloads", () => {
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

  expect(initialCommandNames).toEqual(["test/TodoEditor.List"])

  const pendingListIds = Record.values(initialized.model.requests.pending)
  const listRequest = pipe(pendingListIds, Option.fromIterable, Option.getOrThrow)

  const staleRequest = RequestTokenSchema.make({
    epoch: initialized.model.requests.epoch,
    id: listRequest - 1,
    key: "resource_editor_todos.list",
  })

  const staleMessage = Editor.Message.SucceededList({
    page: { items: [{ id: todoId, title: "Stale", priority: 9 }], nextCursor: null },
    append: false,
    request: staleRequest,
  })

  const stale = Editor.update(initialized.model, staleMessage)

  expect(stale.model.items).toEqual([])

  const request = RequestTokenSchema.make({
    epoch: initialized.model.requests.epoch,
    id: listRequest,
    key: "resource_editor_todos.list",
  })

  const loadedMessage = Editor.Message.SucceededList({
    page: { items: [{ id: todoId, title: "Ship", priority: 2 }], nextCursor: "next" },
    append: false,
    request,
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

  expect(reloadCommandNames).toEqual(["test/TodoEditor.List"])
})
