import { Schema } from "effect"
import { Authorization } from "effect-domains/authorization"
import { Form } from "effect-domains/form"
import { Resource } from "effect-domains/resource"
import { ResourceEditor } from "effect-domains/resource-editor"

const RecordSchema = Schema.Struct({ title: Schema.NonEmptyString })
const FormSchema = Schema.Struct({ title: Form.text(RecordSchema.fields.title) })

const ListOnly = Resource.make({
  name: "resource_editor_list_only",
  schema: RecordSchema,
  authorization: Authorization.public,
  operations: { list: true },
})

ResourceEditor.make({
  name: "test/ListOnlyEditor",
  // @ts-expect-error because an editor requires published create, update, and remove operations.
  resource: ListOnly,
  form: FormSchema,
  empty: { title: "" },
  notices: { created: "Created", updated: "Updated", removed: "Removed" },
  formatError: String,
})
