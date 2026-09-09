import { Array, flow, Function, Option, Record, Schema, Struct, Tuple, pipe } from "effect"
import { Table, TableField, TableCheckSchema } from "./table.ts"
import type { Resource } from "./resource.ts"
import { Policy, type Operand } from "./policy.ts"
import { compileUnaryRpc, type UnaryRpcProcedure } from "./rpc-contract.ts"

type InspectableProcedure = UnaryRpcProcedure

type InspectableApplication = Readonly<{
  name: string
  resources: ReadonlyArray<Resource>
  group: Readonly<{
    requests: Readonly<{
      values: () => Iterable<InspectableProcedure>
    }>
  }>
}>

const schemaDocument = flow(Schema.toCodecJson, Schema.toJsonSchemaDocument)
const ChecksSchema = Schema.Array(TableCheckSchema)
const PhysicalScalarSchema = Schema.Literals(["string", "integer", "number"])
const PhysicalGenerationSchema = Schema.optional(Schema.Literal("uuidv7"))

class PhysicalField extends Schema.Class<PhysicalField>("PhysicalField")({
  name: Schema.String,
  scalar: PhysicalScalarSchema,
  nullable: Schema.Boolean,
  generated: PhysicalGenerationSchema,
  checks: ChecksSchema,
}) {}

const PhysicalFieldsSchema = Schema.Array(PhysicalField)

class PhysicalTable extends Schema.Class<PhysicalTable>("PhysicalTable")({
  name: Schema.String,
  identifier: Schema.String,
  fields: PhysicalFieldsSchema,
}) {}

const SubjectBindingsSchema = Schema.Record(Schema.String, Schema.String)
const CreationSchema = Schema.Struct({ defaults: Schema.Unknown, generated: Schema.Unknown, fromSubject: SubjectBindingsSchema })

const StorageSchema = Schema.Struct({
  schema: Schema.Unknown,
  physical: PhysicalTable,
  insert: Schema.Unknown,
  row: Schema.Unknown,
  stored: Schema.Unknown,
})

const OperationNamesSchema = Schema.Array(Schema.String)

const AuthorizationInspectionSchema = Schema.Union([
  Schema.TaggedStruct("Public", {}),
  Schema.TaggedStruct("Deny", {}),
  Schema.TaggedStruct("Policy", {
    subject: Schema.Unknown,
    scope: Schema.String,
    allow: Schema.Record(Schema.String, Schema.String),
  }),
])

class ResourceInspection extends Schema.Class<ResourceInspection>("ResourceInspection")({
  name: Schema.String,
  operations: OperationNamesSchema,
  schema: Schema.Unknown,
  creation: CreationSchema,
  list: Schema.Unknown,
  authorization: AuthorizationInspectionSchema,
  storage: StorageSchema,
}) {}

class OperationInspection extends Schema.Class<OperationInspection>("OperationInspection")({
  name: Schema.String,
  input: Schema.Unknown,
  output: Schema.Unknown,
  error: Schema.Unknown,
}) {}

const OperationsSchema = Schema.Array(OperationInspection)
const ResourcesSchema = Schema.Array(ResourceInspection)
const CommandsSchema = Schema.Struct({ local: OperationNamesSchema, remote: OperationNamesSchema })
const OpaqueRuntimeSchema = Schema.Struct({ opaque: Schema.String })
const RuntimeSchema = Schema.Struct({ services: OpaqueRuntimeSchema, transactions: OpaqueRuntimeSchema })

class ApplicationInspection extends Schema.Class<ApplicationInspection>("ApplicationInspection")({
  application: Schema.String,
  commands: CommandsSchema,
  operations: OperationsSchema,
  resources: ResourcesSchema,
  runtime: RuntimeSchema,
}) {}

const physicalField = (field: TableField) =>
  PhysicalField.make({
    name: field.name,
    scalar: field.scalar,
    nullable: field.nullable,
    generated: Option.getOrUndefined(field.generation),
    checks: field.checks,
  })

const physicalTable = (table: Table) => {
  const fields = Array.map(table.fields, physicalField)

  return PhysicalTable.make({ name: table.name, identifier: table.identifier, fields })
}

const renderPolicies = (rules: Readonly<Partial<Record<string, Policy>>>) => pipe(rules, Record.map(Option.fromNullishOr), Record.getSomes, Record.map(Policy.render))

const inspectAuthorization = (authorization: Resource["authorization"]) => {
  if (authorization._tag !== "Policy") return authorization
  const subject = schemaDocument(authorization.subject)
  const scope = Policy.render(authorization.scope)
  const allow = renderPolicies(authorization.allow)
  const policyInspectionSchema = Tuple.get(AuthorizationInspectionSchema.members, 2)
  return policyInspectionSchema.make({ subject, scope, allow })
}

const resource = (definition: Resource) => {
  const schema = schemaDocument(definition.schema)
  const storageSchema = schemaDocument(definition.storage)
  const physical = physicalTable(definition.table)
  const insert = schemaDocument(definition.table.insertSchema)
  const row = schemaDocument(definition.table.rowSchema)
  const stored = schemaDocument(definition.table.storageSchema)
  const storage = StorageSchema.make({ schema: storageSchema, physical, insert, row, stored })
  const defaults = pipe(definition.create, Option.flatMap(flow(Struct.get("defaults"), Option.fromNullishOr)), Option.getOrElse(Record.empty))
  const generated = pipe(definition.create, Option.flatMap(flow(Struct.get("generated"), Option.fromNullishOr)), Option.getOrElse(Record.empty))

  const fromSubject = Option.match(definition.create, {
    onNone: Record.empty,
    onSome: (creation) => {
      const bindings = creation.fromSubject ?? Record.empty()
      const subjectBindings = bindings as Readonly<Record<string, Extract<Operand, { readonly _tag: "SubjectField" }>>>
      return Record.map(subjectBindings, (binding) => `subject.${binding.field}`)
    },
  })
  const creation = CreationSchema.make({ defaults, generated, fromSubject })
  const authorization = inspectAuthorization(definition.authorization)

  return ResourceInspection.make({
    name: definition.name,
    operations: definition.operations,
    schema,
    creation,
    list: Option.getOrNull(definition.list),
    authorization,
    storage,
  })
}

const operation = (procedure: InspectableProcedure) => {
  const contract = Option.getOrElse(
    compileUnaryRpc(procedure),
    () => {
      throw new Error(`Application inspection supports only unary RPC procedures: ${procedure._tag}`)
    },
  )
  return OperationInspection.make({
    name: contract.tag,
    input: schemaDocument(contract.payload),
    output: schemaDocument(contract.success),
    error: schemaDocument(contract.error),
  })
}

const describe = <App extends InspectableApplication>(application: App, selected: Option.Option<string> = Option.none()) => {
  const operations = pipe(application.group.requests.values(), Array.fromIterable, Array.map(operation))

  const matching = (name: string) => {
    const named = (entry: OperationInspection) => (entry.name === name)
    return Array.filter(operations, named)
  }

  const matchingOperations = Option.match(selected, {
    onNone: Function.constant(operations),
    onSome: matching,
  })

  const remote = Array.map(operations, Struct.get("name"))
  const commands = CommandsSchema.make({ local: ["serve", "schema", "inspect"], remote })
  const resources = Array.map(application.resources, resource)

  const services = OpaqueRuntimeSchema.make({
    opaque: "Application handler service requirements are not reified by Effect Layer metadata.",
  })

  const transactions = OpaqueRuntimeSchema.make({
    opaque: "Transaction boundaries are authored in handlers and are not inspectable from an RPC group.",
  })

  const runtime = RuntimeSchema.make({ services, transactions })
  return ApplicationInspection.make({ application: application.name, commands, operations: matchingOperations, resources, runtime })
}

export const ApplicationInspect = { describe }
