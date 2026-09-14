import { Schema } from "effect"
import { Authorization } from "effect-domains/authorization"
import { identifier } from "effect-domains/domain"
import { Resource } from "effect-domains/resource"
import { Table } from "effect-domains/table"
const RelationSchema = Schema.Struct({ tenantId: Schema.String, number: Schema.String })
const TenantSchema = Schema.Struct({ tenantId: Schema.String })
const Tenants = Table.make({ name: "tenants", schema: TenantSchema })
interface Relation extends Schema.Schema.Type<typeof RelationSchema> {}
type TableOptions = Parameters<typeof Table.make<"relation_types", typeof RelationSchema>>[0]

const implicitKey: TableOptions = {
  name: "relation_types",
  schema: RelationSchema,
  relations: { unique: [{ fields: ["tenantId", "id"] }] },
}

const resourceCapabilities = [Resource.get()]
const tenantReference = Table.reference(Tenants, ["id"])

const resourceOptions = Resource.define({
  name: "relation_resources",
  schema: RelationSchema,
  authorization: Authorization.public,
  capabilities: resourceCapabilities,
  relations: {
    indexes: [{ fields: ["tenantId", "number"] }],
    foreignKeys: [{ scope: ["tenantId"], fields: ["number"], references: tenantReference }],
  },
})

const invalidTable: TableOptions = {
  name: "relation_types",
  schema: RelationSchema,
  // @ts-expect-error because local relation fields must exist in the persisted row.
  relations: { unique: [{ name: "bad_unique", fields: ["missing"] }] },
}

// @ts-expect-error because resource relation fields are not arbitrary strings.
const invalidResource = Resource.define({
  name: "relation_resources",
  schema: RelationSchema,
  authorization: Authorization.public,
  capabilities: [],
  relations: { indexes: [{ name: "bad_index", fields: ["missing"] }] },
})

// @ts-expect-error because referenced fields must exist on the target table.
const invalidReference = Table.reference(Tenants, ["missing"])

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
void invalidReference
void invalidImplicitKey
