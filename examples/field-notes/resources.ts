import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleRoles, ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { FieldReportSchema } from "./domain.ts"
import { StoredFieldReportSchema } from "./storage.ts"

const p = Authorization.for({ resource: FieldReportSchema, subject: ExampleSubjectSchema })

const scope = p.all()

const authorization = p.policy({
  scope,
  allow: {
    read: ExampleRoles.reader,
    create: ExampleRoles.editor,
    update: ExampleRoles.editor,
    remove: ExampleRoles.admin,
  },
})

const fieldReportCapabilities = [
  Resource.get(),
  Resource.list({ filter: ["site"], limit: 50 }),
  Resource.create(),
  Resource.update(),
  Resource.remove(),
]

export const FieldReportsResource = Resource.define({
  authorization,
  name: "reports",
  schema: FieldReportSchema,
  storage: StoredFieldReportSchema,
  capabilities: fieldReportCapabilities,
})
