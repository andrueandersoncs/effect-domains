import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { ExampleSubjectSchema } from "../authentication.ts"
import { TodoSchema } from "./domain.ts"

const p = Authorization.for({ resource: TodoSchema, subject: ExampleSubjectSchema })
const scope = p.eq(p.row.tenantId, p.subject.tenantId)
const owned = p.eq(p.row.ownerId, p.subject.userId)
const administrator = p.includes(p.subject.roles, "admin")
const ownerOrAdministrator = p.any(owned, administrator)
const candidateOwner = p.eq(p.next.ownerId, p.subject.userId)
const unchangedOwnership = p.unchanged("tenantId", "ownerId")
const incomplete = p.eq(p.row.completed, false)
const incompleteOwned = p.all(owned, incomplete)
const editable = p.any(administrator, incompleteOwned)
const protectedEdit = p.all(unchangedOwnership, editable)

const authorization = p.policy({
  scope,
  allow: {
    read: ownerOrAdministrator,
    create: candidateOwner,
    update: protectedEdit,
    patch: protectedEdit,
    remove: administrator,
  },
})

export const TodosResource = Resource.make({
  authorization,
  name: "todos",
  schema: TodoSchema,
  create: {
    defaults: { completed: false },
    fromSubject: { tenantId: p.subject.tenantId, ownerId: p.subject.userId },
  },
  list: {
    filter: ["completed"],
    order: [{ field: "title" }],
    limit: 25,
  },
  operations: [...Resource.crud, "patch"] as const,
})
