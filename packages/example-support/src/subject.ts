import { Schema } from "effect"
import { Authorization } from "effect-domains/authorization"

export const ExampleSubjectSchema = Schema.Struct({
  userId: Schema.String,
  tenantId: Schema.String,
  roles: Schema.Array(Schema.Literals(["reader", "editor", "admin"])),
})

const subject = Authorization.subject(ExampleSubjectSchema)

const readerRole = subject.includes(subject.subject.roles, "reader")
const editorRole = subject.includes(subject.subject.roles, "editor")
const adminRole = subject.includes(subject.subject.roles, "admin")
const readerRoles = subject.any(readerRole, editorRole, adminRole)
const editorRoles = subject.any(editorRole, adminRole)

export const ExampleRoles = {
  reader: subject.policy(readerRoles),
  editor: subject.policy(editorRoles),
  admin: subject.policy(adminRole),
}
