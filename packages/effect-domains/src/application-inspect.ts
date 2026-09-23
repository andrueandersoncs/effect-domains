import { Array, Context, Effect, flow, Option, Record, Schema } from "effect"
import type { ApplicationIR } from "./application.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { EntitlementRequirementSchema, EntitlementRequirementsSchema, type SubjectPolicy } from "./authorization.ts"
import { Command, type CommandLive } from "./command.ts"
import { CreationInspectionSchema } from "./resource-creation.ts"
import { Policy } from "./policy.ts"
import { ReadModel, ReadModelDescription } from "./read-model.ts"
import type { Resource } from "./resource.ts"
import { compileUnaryRpc, type RpcProcedure } from "./rpc-contract.ts"
import { Table, TableSnapshot } from "./table.ts"
type CommandInspectionInput = Readonly<Pick<CommandLive["spec"], "policy" | "dependencies">>

type InspectableCommand = Readonly<{
  spec: CommandInspectionInput & Readonly<{ name: string }>
}>

type InspectableResource = Readonly<Pick<
  Resource,
  | "name"
  | "schema"
  | "storage"
  | "table"
  | "authorization"
  | "version"
  | "transitions"
  | "contracts"
  | "operations"
  | "creation"
  | "list"
>>

type InspectableApplication = Readonly<{
  name: string
  commands: ReadonlyArray<InspectableCommand>
  group: Readonly<{ requests: ApplicationIR["group"]["requests"] }>
  featureFlags: ReadonlyArray<Readonly<{
    name: string
    default: boolean
    description?: string
  }>>
  resources: ReadonlyArray<InspectableResource>
}>



const schemaDocument = flow(Schema.toCodecJson, Schema.toJsonSchemaDocument)
const PhysicalTableJsonSchema = Schema.toCodecJson(TableSnapshot)
const PhysicalTableSchema = Schema.toEncoded(PhysicalTableJsonSchema)
const encodePhysicalTable = Schema.encodeEffect(PhysicalTableJsonSchema)

const StorageSchema = Schema.Struct({
  schema: Schema.Unknown,
  physical: PhysicalTableSchema,
  insert: Schema.Unknown,
  row: Schema.Unknown,
  stored: Schema.Unknown,
})


const OperationNamesSchema = Schema.Array(Schema.String)
const PolicyRulesSchema = Schema.Record(Schema.String, Schema.String)
const PolicyInspectionSchema = Schema.TaggedStruct("Policy", { subject: Schema.Unknown, scope: Schema.String, allow: PolicyRulesSchema, require: Schema.optionalKey(EntitlementRequirementsSchema) })
const AuthorizationInspectionSchema = Schema.Union([Schema.TaggedStruct("Public", {}), Schema.TaggedStruct("Deny", {}), PolicyInspectionSchema])

const FeatureFlagInspectionSchema = Schema.Struct({
  name: Schema.String,
  default: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
})

const FeatureFlagsInspectionSchema = Schema.Array(FeatureFlagInspectionSchema)

const ResourceInspectionSchema = Schema.Struct({
  name: Schema.String,
  operations: OperationNamesSchema,
  schema: Schema.Unknown,
  creation: CreationInspectionSchema,
  list: Schema.Unknown,
  version: Schema.optionalKey(Schema.String),
  transitions: Schema.optionalKey(Schema.Unknown),
  authorization: AuthorizationInspectionSchema,
  storage: StorageSchema,
})


const SubjectPolicyInspectionSchema = Schema.Struct({ subject: Schema.Unknown, rule: Schema.String, require: Schema.Array(EntitlementRequirementSchema) })

const OperationInspectionSchema = Schema.Struct({
  name: Schema.String,
  input: Schema.Unknown,
  output: Schema.Unknown,
  error: Schema.Unknown,
  subjectPolicy: Schema.optionalKey(SubjectPolicyInspectionSchema),
  views: Schema.optionalKey(Schema.Array(ReadModelDescription)),
})

interface OperationInspection extends Schema.Schema.Type<typeof OperationInspectionSchema> {}

const OperationsSchema = Schema.Array(OperationInspectionSchema)
const ResourcesSchema = Schema.Array(ResourceInspectionSchema)
const CommandsSchema = Schema.Struct({ local: OperationNamesSchema, remote: OperationNamesSchema })


const ApplicationInspectionSchema = Schema.Struct({
  application: Schema.String,
  commands: CommandsSchema,
  featureFlags: FeatureFlagsInspectionSchema,
  operations: OperationsSchema,
  resources: ResourcesSchema,
})


const renderPolicies = (
  rules: Readonly<Partial<Record<string, Policy>>>,
) => {
  const rendered: Record<string, string> = {}

  for (const name in rules) {
    const policy = rules[name]
    if (policy !== undefined) rendered[name] = Policy.render(policy)
  }

  return rendered
}

const inspectAuthorization = (authorization: InspectableResource["authorization"]) => {
  if (authorization._tag !== "Policy") return authorization

  const subject = schemaDocument(authorization.subject)
  const scope = Policy.render(authorization.scope)
  const allow = renderPolicies(authorization.allow)

  return PolicyInspectionSchema.make({ subject, scope, allow, require: authorization.require })
}

const inspectResource = Effect.fn("ApplicationInspect.resource")(function* (definition: InspectableResource) {
  const schema = schemaDocument(definition.schema)
  const storageSchema = schemaDocument(definition.storage)
  const snapshot = Table.snapshot(definition.table)
  const physical = yield* encodePhysicalTable(snapshot)
  const insert = schemaDocument(definition.table.insertSchema)
  const row = schemaDocument(definition.table.rowSchema)
  const stored = schemaDocument(definition.table.storageSchema)
  const storage = StorageSchema.make({ schema: storageSchema, physical, insert, row, stored })
  const authorization = inspectAuthorization(definition.authorization)
  const version = definition.version
  const transitions = definition.transitions
  const versionFields = version == null ? {} : { version }
  const transitionFields = transitions == null ? {} : { transitions: transitions.inspection }
  const hasContract = (operation: InspectableResource["operations"][number]) => Record.has(definition.contracts, operation)
  const operations = Array.filter(definition.operations, hasContract)

  return ResourceInspectionSchema.make({
    name: definition.name,
    operations,
    schema,
    creation: definition.creation,
    list: definition.list,
    ...versionFields,
    ...transitionFields,
    authorization,
    storage,
  })
})

class InspectionError extends Schema.TaggedError<InspectionError>()("ApplicationInspectionError", {
  reason: Schema.String,
}) {}

const inspectSubjectPolicy = (policy: SubjectPolicy) => {
  const subject = schemaDocument(policy.subject)
  const rule = Policy.render(policy.expression)

  return SubjectPolicyInspectionSchema.make({ subject, rule, require: policy.require })
}


const inspectViews = (dependencies: CommandInspectionInput["dependencies"]) => {
  const resolved = Command.dependencies(dependencies ?? [])

  return Array.map(resolved.readModels, (readModel) => {
    switch (readModel._tag) {
      case "ReadModelSpec":
        return ReadModel.describe(readModel)
      case "CompiledReadModel":
        return readModel.description
    }
  })
}

const inspectOperation = Effect.fn("ApplicationInspect.operation")(function* (
  procedure: RpcProcedure,
  command: CommandInspectionInput | undefined,
) {
  const compiled = compileUnaryRpc(procedure)
  const contract = yield* Effect.fromOption(
    compiled,
    () => InspectionError.make({
      reason: `Application inspection supports only unary RPC procedures: ${procedure._tag}`,
    }),
  )
  const input = schemaDocument(contract.payloadSchema)
  const output = schemaDocument(contract.successSchema)
  const error = schemaDocument(contract.errorSchema)
  const nativePolicyOption = Context.getOption(procedure.annotations, AuthorizationRpc.policy)
  const nativePolicy = Option.getOrUndefined(nativePolicyOption)
  const policy = command?.policy ?? nativePolicy
  const subjectPolicyFields = policy === undefined
    ? {}
    : { subjectPolicy: inspectSubjectPolicy(policy) }
  const viewFields = command === undefined
    ? {}
    : { views: inspectViews(command.dependencies) }

  return OperationInspectionSchema.make({
    name: contract._tag,
    input,
    output,
    error,
    ...subjectPolicyFields,
    ...viewFields,
  })
})

// Inspection is a lossless projection of bounded, compile-time application metadata.
// Its output contract requires every operation, resource, and feature flag.
const describe = Effect.fn("ApplicationInspect.describe")(function* (
  application: InspectableApplication,
  selected: Option.Option<string> = Option.none(),
  localCommands: ReadonlyArray<string> = ["serve", "inspect"],
) {
  const commandIndex = new Map<string, CommandInspectionInput>()

  for (const command of application.commands) {
    commandIndex.set(command.spec.name, command.spec)
  }

  const selectedName = Option.getOrUndefined(selected)
  const operations: OperationInspection[] = []
  const remote: string[] = []

  for (const procedure of application.group.requests.values()) {
    const command = commandIndex.get(procedure._tag)
    const inspected = yield* inspectOperation(procedure, command)

    remote.push(inspected.name)

    if (selectedName === undefined || inspected.name === selectedName) {
      operations.push(inspected)
    }
  }

  const commands = CommandsSchema.make({ local: localCommands, remote })
  const featureFlags = Array.map(
    application.featureFlags,
    (flag) => FeatureFlagInspectionSchema.make(flag),
  )
  const resources = yield* Effect.forEach(application.resources, inspectResource, { concurrency: 1 })

  return ApplicationInspectionSchema.make({
    application: application.name,
    featureFlags,
    commands,
    operations,
    resources,
  })
})

export const ApplicationInspect = { describe }
