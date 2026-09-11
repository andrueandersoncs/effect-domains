import { Array, Context, Effect, Equivalence, flow, Function, Option, Record, Schema, Struct, pipe } from "effect"
import { Table, TableSnapshot } from "./table.ts"
import type { Resource } from "./resource.ts"
import { Policy } from "./policy.ts"
import { CreationInspectionSchema } from "./resource-creation.ts"
import { compileUnaryRpc, type RpcProcedure } from "./rpc-contract.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { EntitlementRequirementSchema, EntitlementRequirementsSchema, type SubjectPolicy } from "./authorization.ts"
import { SqliteView, SqliteViewDescriptionSchema } from "./sqlite-view.ts"

type InspectableApplication = Readonly<{
  name: string
  resources: ReadonlyArray<Resource>
  group: Readonly<{
    requests: Readonly<{
      values: () => Iterable<RpcProcedure>
    }>
  }>
}>

const schemaDocument = flow(Schema.toCodecJson, Schema.toJsonSchemaDocument)
const PhysicalTableJsonSchema = Schema.toCodecJson(TableSnapshot)
const PhysicalTableSchema = Schema.toEncoded(PhysicalTableJsonSchema)
const encodePhysicalTable = Schema.encodeSync(PhysicalTableJsonSchema)

const StorageSchema = Schema.Struct({
  schema: Schema.Unknown,
  physical: PhysicalTableSchema,
  insert: Schema.Unknown,
  row: Schema.Unknown,
  stored: Schema.Unknown,
})

interface Storage extends Schema.Schema.Type<typeof StorageSchema> {}
const OperationNamesSchema = Schema.Array(Schema.String)
const PolicyRulesSchema = Schema.Record(Schema.String, Schema.String)
const PolicyInspectionSchema = Schema.TaggedStruct("Policy", { subject: Schema.Unknown, scope: Schema.String, allow: PolicyRulesSchema, require: Schema.optionalKey(EntitlementRequirementsSchema) })
const AuthorizationInspectionSchema = Schema.Union([Schema.TaggedStruct("Public", {}), Schema.TaggedStruct("Deny", {}), PolicyInspectionSchema])

const ResourceInspectionSchema = Schema.Struct({
  name: Schema.String,
  operations: OperationNamesSchema,
  schema: Schema.Unknown,
  creation: CreationInspectionSchema,
  list: Schema.Unknown,
  authorization: AuthorizationInspectionSchema,
  storage: StorageSchema,
})

interface ResourceInspection extends Schema.Schema.Type<typeof ResourceInspectionSchema> {}
const SubjectPolicyInspectionSchema = Schema.Struct({ subject: Schema.Unknown, rule: Schema.String, require: Schema.Array(EntitlementRequirementSchema) })

const OperationInspectionSchema = Schema.Struct({
  name: Schema.String,
  input: Schema.Unknown,
  output: Schema.Unknown,
  error: Schema.Unknown,
  subjectPolicy: Schema.optionalKey(SubjectPolicyInspectionSchema),
  views: Schema.optionalKey(Schema.Array(SqliteViewDescriptionSchema)),
})

interface OperationInspection extends Schema.Schema.Type<typeof OperationInspectionSchema> {}
const OperationsSchema = Schema.Array(OperationInspectionSchema)
const ResourcesSchema = Schema.Array(ResourceInspectionSchema)
const CommandsSchema = Schema.Struct({ local: OperationNamesSchema, remote: OperationNamesSchema })
interface Commands extends Schema.Schema.Type<typeof CommandsSchema> {}

const ApplicationInspectionSchema = Schema.Struct({
  application: Schema.String,
  commands: CommandsSchema,
  operations: OperationsSchema,
  resources: ResourcesSchema,
})

interface ApplicationInspection extends Schema.Schema.Type<typeof ApplicationInspectionSchema> {}


const renderPolicies = (rules: Readonly<Partial<Record<string, Policy>>>) => pipe(rules, Record.map(Option.fromNullishOr), Record.getSomes, Record.map(Policy.render))

const inspectAuthorization = (authorization: Resource["authorization"]) => {
  if (authorization._tag !== "Policy") return authorization
  const subject = schemaDocument(authorization.subject)
  const scope = Policy.render(authorization.scope)
  const allow = renderPolicies(authorization.allow)
  return PolicyInspectionSchema.make({ subject, scope, allow, require: authorization.require })
}

const resource = (definition: Resource) => {
  const schema = schemaDocument(definition.schema)
  const storageSchema = schemaDocument(definition.storage)
  const physical = pipe(Table.snapshot(definition.table), encodePhysicalTable)
  const insert = schemaDocument(definition.table.insertSchema)
  const row = schemaDocument(definition.table.rowSchema)
  const stored = schemaDocument(definition.table.storageSchema)
  const storage = StorageSchema.make({ schema: storageSchema, physical, insert, row, stored })
  const authorization = inspectAuthorization(definition.authorization)

  return ResourceInspectionSchema.make({
    name: definition.name,
    operations: definition.operations,
    schema,
    creation: definition.creation,
    list: definition.list,
    authorization,
    storage,
  })
}

class InspectionError extends Schema.TaggedError<InspectionError>()("ApplicationInspectionError", {
  reason: Schema.String,
}) {}

const inspectSubjectPolicy = (policy: SubjectPolicy) => {
  const subject = schemaDocument(policy.subject)
  const rule = Policy.render(policy.expression)
  return SubjectPolicyInspectionSchema.make({ subject, rule, require: policy.require })
}

const inspectOperation = Effect.fn("ApplicationInspect.operation")(function* (procedure: RpcProcedure) {
  const compiled = compileUnaryRpc(procedure)

  const contract = yield* Effect.fromOption(
    compiled,
    () => InspectionError.make({ reason: `Application inspection supports only unary RPC procedures: ${procedure._tag}` }),
  )

  const input = schemaDocument(contract.payloadSchema)
  const output = schemaDocument(contract.successSchema)
  const error = schemaDocument(contract.errorSchema)
  const policy = Context.getOption(procedure.annotations, AuthorizationRpc.policy)
  const subjectPolicy = Option.map(policy, inspectSubjectPolicy)

  const views = pipe(
    Context.getOption(procedure.annotations, SqliteView.annotation),
    Option.map(Array.map(Struct.get("description"))),
  )

  return OperationInspectionSchema.make({
    name: contract._tag, input, output, error,
    ...Option.match(subjectPolicy, { onNone: () => ({}), onSome: (subjectPolicy) => ({ subjectPolicy }) }),
    ...Option.match(views, { onNone: () => ({}), onSome: (views) => ({ views }) }),
  })
})

const operation = flow(inspectOperation, Effect.runSync)
const sameName = Equivalence.strictEqual<string>()

const describe = <App extends InspectableApplication>(
  application: App,
  selected: Option.Option<string> = Option.none(),
  localCommands: ReadonlyArray<string> = ["serve", "inspect"],
) => {
  const operations = pipe(application.group.requests.values(), Array.fromIterable, Array.map(operation))

  const matchingOperations = Option.match(selected, {
    onNone: Function.constant(operations),
    onSome: (name) => {
      const named = (entry: OperationInspection) => sameName(entry.name, name)
      return Array.filter(operations, named)
    },
  })

  const remote = Array.map(operations, Struct.get("name"))
  const commands = CommandsSchema.make({ local: localCommands, remote })
  const resources = Array.map(application.resources, resource)

  return ApplicationInspectionSchema.make({
    application: application.name,
    commands,
    operations: matchingOperations,
    resources,
  })
}

export const ApplicationInspect = { describe }
