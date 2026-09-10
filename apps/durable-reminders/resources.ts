import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleSubjectSchema } from "@effect-domains/example-support/authentication"
import { ReminderReceiptSchema } from "./domain.ts"

const policy = Authorization.for({
  resource: ReminderReceiptSchema,
  subject: ExampleSubjectSchema,
})

const operator = policy.includes(policy.subject.roles, "admin")

const authorization = policy.policy({
  scope: operator,
  allow: { read: operator },
})

export const ReminderReceiptResource = Resource.make({
  authorization,
  name: "reminder_receipts",
  schema: ReminderReceiptSchema,
  operations: {
    get: true,
    list: {
      filter: ["recipient", "requestId"],
      limit: 100,
      order: [{ field: "id", direction: "asc" }],
    },
  },
})
