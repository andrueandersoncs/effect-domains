import { Array, Function, Option, Record, Schema, pipe } from "effect"
import { Form } from "./form.ts"

const NoticeSchema = Schema.NullOr(Schema.Struct({
  kind: Schema.Literals(["info", "error", "success"]),
  text: Schema.String,
}))

const FieldErrorsSchema = Schema.Record(Schema.String, Schema.String)

const FormFailureSchema = Schema.TaggedStruct("FormFailure", {
  errors: FieldErrorsSchema,
  message: Schema.String,
})

const FailureSchema = Schema.Struct({
  error: Schema.String,
  fieldErrors: FieldErrorsSchema,
})

type FieldErrors = typeof FieldErrorsSchema.Type

const emptyFieldErrors = () => FieldErrorsSchema.make({})

const firstError = (errors: FieldErrors, fallback: string) => pipe(
  Record.values(errors),
  Array.head,
  Option.getOrElse(Function.constant(fallback)),
)

const formFailure = (error: Schema.SchemaError) => {
  const errors = Form.errors(error)
  const message = firstError(errors, error.message)

  return FormFailureSchema.make({ errors, message })
}

const fieldFailure = (field: string) => (error: Schema.SchemaError) => {
  const decodedErrors = Form.errors(error)
  const errors = FieldErrorsSchema.make({ [field]: decodedErrors["$"] ?? error.message })
  const message = firstError(errors, error.message)

  return FormFailureSchema.make({ errors, message })
}

const isFormFailure = Schema.is(FormFailureSchema)

const failure = (error: unknown, formatError: (error: unknown) => string) => isFormFailure(error)
  ? FailureSchema.make({ error: error.message, fieldErrors: error.errors })
  : FailureSchema.make({ error: formatError(error), fieldErrors: emptyFieldErrors() })

export const BrowserModel = {
  NoticeSchema,
  FieldErrorsSchema,
  FormFailureSchema,
  emptyFieldErrors,
  formFailure,
  fieldFailure,
  isFormFailure,
  failure,
}
