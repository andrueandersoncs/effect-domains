import { Schema } from "effect"
import { Authorization } from "effect-domains/authorization"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { Table } from "effect-domains/table"
const RelationSchema = Schema.Struct({ tenantId: Schema.String, number: Schema.String })
interface Relation extends Schema.Schema.Type<typeof RelationSchema> {}
type TableOptions = Parameters<typeof Table.make<"relation_types", typeof RelationSchema>>[0]
type ResourceOptions = Parameters<typeof Resource.make<"relation_resources", typeof RelationSchema>>[0]

const implicitKey: TableOptions = {
  name: "relation_types",
  schema: RelationSchema,
  relations: { unique: [{ name: "tenant_id", fields: ["tenantId", "id"] }] },
}

const resourceOptions: ResourceOptions = {
  name: "relation_resources",
  schema: RelationSchema,
  authorization: Authorization.public,
  operations: { get: true },
  relations: {
    indexes: [{ name: "tenant_number", fields: ["tenantId", "number"] }],
    foreignKeys: [{ name: "tenant_parent", fields: ["tenantId"], references: { table: "tenants", fields: ["id"] } }],
  },
}

const invalidTable: TableOptions = {
  name: "relation_types",
  schema: RelationSchema,
  // @ts-expect-error because local relation fields must exist in the persisted row.
  relations: { unique: [{ name: "bad_unique", fields: ["missing"] }] },
}

const invalidResource: ResourceOptions = {
  name: "relation_resources",
  schema: RelationSchema,
  authorization: Authorization.public,
  operations: {},
  // @ts-expect-error because resource relation fields are not arbitrary strings.
  relations: { indexes: [{ name: "bad_index", fields: ["missing"] }] },
}

const ExplicitIdentitySchema = Schema.Struct({ key: identifier(Schema.String), value: Schema.String })
interface ExplicitIdentity extends Schema.Schema.Type<typeof ExplicitIdentitySchema> {}
type ExplicitOptions = Parameters<typeof Table.make<"explicit_relation_types", typeof ExplicitIdentitySchema>>[0]

const invalidImplicitKey: ExplicitOptions = {
  name: "explicit_relation_types",
  schema: ExplicitIdentitySchema,
  // @ts-expect-error because an explicit identity does not add an implicit id column.
  relations: { indexes: [{ name: "bad_identity", fields: ["id"] }] },
}

void implicitKey
void resourceOptions
void invalidTable
void invalidResource
void invalidImplicitKey
