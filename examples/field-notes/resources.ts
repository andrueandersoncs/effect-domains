import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleSubjectSchema } from "@effect-domains/example-support/authentication"
import { FieldReportSchema } from "./domain.ts"
import { StoredFieldReportSchema } from "./storage.ts"

const p = Authorization.for({ resource: FieldReportSchema, subject: ExampleSubjectSchema })
const allReports = p.all()
const reader = p.includes(p.subject.roles, "reader")
const editor = p.includes(p.subject.roles, "editor")
const administrator = p.includes(p.subject.roles, "admin")
const readAccess = p.any(reader, editor, administrator)
const writeAccess = p.any(editor, administrator)

const authorization = p.policy({
  scope: allReports,
  allow: {
    read: readAccess,
    create: writeAccess,
    update: writeAccess,
    remove: administrator,
  },
})

export const FieldReportsResource = Resource.make({
  authorization,
  name: "reports",
  schema: FieldReportSchema,
  storage: StoredFieldReportSchema,
  operations: {
    ...Resource.crud,
    list: { filter: ["site"], limit: 50 },
  },
})
