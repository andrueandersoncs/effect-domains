import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleRoles, ExampleSubjectSchema } from "@effect-domains/example-support/subject"
import { TaskSchema } from "./domain.ts"

const p = Authorization.for({ resource: TaskSchema, subject: ExampleSubjectSchema })
const scope = p.sameAs("tenantId")
const owned = p.eq(p.row.ownerId, p.subject.userId)
const ownerOrAdministrator = p.any(owned, ExampleRoles.admin.expression)
const candidateOwner = p.eq(p.next.ownerId, p.subject.userId)
const unchangedOwnership = p.unchanged("tenantId", "ownerId")
const incomplete = p.eq(p.row.completed, false)
const incompleteOwned = p.all(owned, incomplete)
const editable = p.any(ExampleRoles.admin.expression, incompleteOwned)
const protectedEdit = p.all(unchangedOwnership, editable)

const authorization = p.policy({
  scope,
  allow: {
    read: ownerOrAdministrator,
    create: candidateOwner,
    update: protectedEdit,
    patch: protectedEdit,
    remove: ExampleRoles.admin,
  },
})

const taskCreateSources = {
  completed: Resource.default(false),
  priority: Resource.default("normal"),
  tenantId: Resource.fromSubject(p.subject.tenantId),
  ownerId: Resource.fromSubject(p.subject.userId),
}

const taskCapabilities = [
  Resource.get(),
  Resource.list({
    filter: ["project", "priority", "completed"],
    limit: 25,
  }),
  Resource.create({ sources: taskCreateSources }),
  Resource.update(),
  Resource.remove(),
  Resource.patch(),
]

export const TasksResource = Resource.define({
  authorization,
  name: "todos",
  schema: TaskSchema,
  capabilities: taskCapabilities,
})
