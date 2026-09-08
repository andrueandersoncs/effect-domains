import { Option, Schema } from "effect"
import { Table } from "./table.ts"
import type { Resource } from "./resource.ts"

type InspectableProcedure = Readonly<{
  _tag: string
  payloadSchema: Schema.Constraint
  successSchema: Schema.Constraint
  errorSchema: Schema.Constraint
}>

type InspectableResource = Pick<Resource, "name" | "schema" | "storage" | "operations" | "create" | "list" | "table">

type InspectableApplication = Readonly<{
  name: string
  resources: ReadonlyArray<InspectableResource>
  group: Readonly<{
    requests: Readonly<{
      values: () => Iterable<InspectableProcedure>
    }>
  }>
}>

const schemaDocument = (schema: Schema.Constraint) =>
  Schema.toJsonSchemaDocument(Schema.toCodecJson(schema))

const physicalTable = (table: Table) => ({
  name: table.name,
  identifier: table.identifier,
  fields: table.fields.map((field) => ({
    name: field.name,
    scalar: field.scalar,
    nullable: field.nullable,
    generated: Option.getOrUndefined(field.generation),
    checks: field.checks,
  })),
})

const resource = (definition: InspectableResource) => ({
  name: definition.name,
  operations: definition.operations,
  schema: schemaDocument(definition.schema),
  creation: {
    defaults: definition.create?.defaults ?? {},
    generated: definition.create?.generated ?? {},
  },
  list: definition.list ?? null,
  storage: {
    schema: schemaDocument(definition.storage),
    physical: physicalTable(definition.table),
    insert: schemaDocument(definition.table.insertSchema),
    row: schemaDocument(definition.table.rowSchema),
    stored: schemaDocument(definition.table.storageSchema),
  },
})

const operation = (procedure: InspectableProcedure) => ({
  name: procedure._tag,
  input: schemaDocument(procedure.payloadSchema),
  output: schemaDocument(procedure.successSchema),
  error: schemaDocument(procedure.errorSchema),
})

const describe = <App extends InspectableApplication>(application: App, selected?: string) => {
  const operations = Array.from(application.group.requests.values(), operation)
  const matchingOperations = selected === undefined
    ? operations
    : operations.filter((entry) => entry.name === selected)

  return {
    application: application.name,
    commands: {
      local: ["serve", "schema", "inspect"],
      remote: operations.map((entry) => entry.name),
    },
    operations: matchingOperations,
    resources: application.resources.map(resource),
    runtime: {
      services: {
        opaque: "Application handler service requirements are not reified by Effect Layer metadata.",
      },
      transactions: {
        opaque: "Transaction boundaries are authored in handlers and are not inspectable from an RPC group.",
      },
    },
  }
}

export const ApplicationInspect = { describe }
