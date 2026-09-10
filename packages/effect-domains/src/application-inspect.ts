import { Array, Effect, Equivalence, flow, Function, Option, Record, Schema, Struct, pipe } from "effect"
import { Table, TableSnapshot } from "./table.ts"
import type { Resource } from "./resource.ts"
import { Policy, type Operand } from "./policy.ts"
import { compileUnaryRpc, type RpcProcedure } from "./rpc-contract.ts"

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
const SubjectBindingsSchema = Schema.Record(Schema.String, Schema.String)
const CreationSchema = Schema.Struct({ defaults: Schema.Unknown, generated: Schema.Unknown, fromSubject: SubjectBindingsSchema })
interface Creation extends Schema.Schema.Type<typeof CreationSchema> {}

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
const PolicyInspectionSchema = Schema.TaggedStruct("Policy", { subject: Schema.Unknown, scope: Schema.String, allow: PolicyRulesSchema })
const AuthorizationInspectionSchema = Schema.Union([Schema.TaggedStruct("Public", {}), Schema.TaggedStruct("Deny", {}), PolicyInspectionSchema])

const ResourceInspectionSchema = Schema.Struct({
  name: Schema.String,
  operations: OperationNamesSchema,
  schema: Schema.Unknown,
  creation: CreationSchema,
  list: Schema.Unknown,
  authorization: AuthorizationInspectionSchema,
  storage: StorageSchema,
})

interface ResourceInspection extends Schema.Schema.Type<typeof ResourceInspectionSchema> {}
const OperationInspectionSchema = Schema.Struct({ name: Schema.String, input: Schema.Unknown, output: Schema.Unknown, error: Schema.Unknown })
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
  return PolicyInspectionSchema.make({ subject, scope, allow })
}

const resource = (definition: Resource) => {
  const schema = schemaDocument(definition.schema)
  const storageSchema = schemaDocument(definition.storage)
  const physical = pipe(Table.snapshot(definition.table), encodePhysicalTable)
  const insert = schemaDocument(definition.table.insertSchema)
  const row = schemaDocument(definition.table.rowSchema)
  const stored = schemaDocument(definition.table.storageSchema)
  const storage = StorageSchema.make({ schema: storageSchema, physical, insert, row, stored })
  const policy = Option.getOrUndefined(definition.create)
  const defaults = policy?.defaults ?? {}
  const generated = policy?.generated ?? {}

  const fromSubject = Option.match(definition.create, {
    onNone: Record.empty,
    onSome: (creation) => {
      const subjectBindings = (creation.fromSubject ?? Record.empty()) as Readonly<Record<string, Extract<Operand, { readonly _tag: "SubjectField" }>>>
      return Record.map(subjectBindings, (binding) => `subject.${binding.field}`)
    },
  })

  const creation = CreationSchema.make({ defaults, generated, fromSubject })
  const authorization = inspectAuthorization(definition.authorization)

  return ResourceInspectionSchema.make({
    name: definition.name,
    operations: definition.operations,
    schema,
    creation,
    list: definition.list,
    authorization,
    storage,
  })
}

class InspectionError extends Schema.TaggedError<InspectionError>()("ApplicationInspectionError", {
  reason: Schema.String,
}) {}

const inspectOperation = Effect.fn("ApplicationInspect.operation")(function* (procedure: RpcProcedure) {
  const compiled = compileUnaryRpc(procedure)

  const contract = yield* Effect.fromOption(
    compiled,
    () => InspectionError.make({ reason: `Application inspection supports only unary RPC procedures: ${procedure._tag}` }),
  )

  const input = schemaDocument(contract.payloadSchema)
  const output = schemaDocument(contract.successSchema)
  const error = schemaDocument(contract.errorSchema)
  return OperationInspectionSchema.make({ name: contract._tag, input, output, error })
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
