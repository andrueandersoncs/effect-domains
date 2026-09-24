import { Array, Context, Effect, Equivalence, flow, Function, HashMap, Match, Option, pipe, Predicate, Record, Schema, Struct, Tuple } from "effect"
import type { ApplicationIR } from "./application.ts"
import { AuthorizationRpc } from "./authorization-rpc.ts"
import { EntitlementRequirementSchema, EntitlementRequirementsSchema, type SubjectPolicy } from "./authorization-model.ts"
import { Command, type CommandLive } from "./command.ts"
import { CreationInspectionSchema } from "./resource-creation.ts"
import { Policy } from "./policy.ts"
import { ReadModel } from "./read-model.ts"
import { type CompiledReadModel, ReadModelDescription } from "./read-model-syntax.ts"
import type { Resource } from "./resource-model.ts"
import { compileUnaryRpc, type RpcProcedure } from "./rpc-contract.ts"
import { Table } from "./table.ts"
import { TableSnapshot } from "./table-snapshot-model.ts"



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

type InspectableApplication = Readonly<Pick<ApplicationIR, "name" | "commands" | "group" | "featureFlags">> & Readonly<{
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

interface Storage extends Schema.Schema.Type<typeof StorageSchema> {}


const OperationNamesSchema = Schema.Array(Schema.String)
const PolicyRulesSchema = Schema.Record(Schema.String, Schema.String)
const PolicyInspectionSchema = Schema.TaggedStruct("Policy", { subject: Schema.Unknown, scope: Schema.String, allow: PolicyRulesSchema, require: Schema.optionalKey(EntitlementRequirementsSchema) })
const AuthorizationInspectionSchema = Schema.Union([Schema.TaggedStruct("Public", {}), Schema.TaggedStruct("Deny", {}), PolicyInspectionSchema])

const OptionalStringSchema = Schema.optionalKey(Schema.String)

class FeatureFlagInspection extends Schema.Class<FeatureFlagInspection>("FeatureFlagInspection")({
  name: Schema.String,
  default: Schema.Boolean,
  description: OptionalStringSchema,
}) {}

const FeatureFlagsInspectionSchema = Schema.Array(FeatureFlagInspection)

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

interface ResourceInspection extends Schema.Schema.Type<typeof ResourceInspectionSchema> {}


const EntitlementRequirementListSchema = Schema.Array(EntitlementRequirementSchema)

class SubjectPolicyInspection extends Schema.Class<SubjectPolicyInspection>("SubjectPolicyInspection")({
  subject: Schema.Unknown,
  rule: Schema.String,
  require: EntitlementRequirementListSchema,
}) {}

const OptionalSubjectPolicyInspectionSchema = Schema.optionalKey(SubjectPolicyInspection)
const ViewInspectionListSchema = Schema.Array(ReadModelDescription)
const OptionalViewInspectionListSchema = Schema.optionalKey(ViewInspectionListSchema)

class OperationInspection extends Schema.Class<OperationInspection>("OperationInspection")({
  name: Schema.String,
  input: Schema.Unknown,
  output: Schema.Unknown,
  error: Schema.Unknown,
  subjectPolicy: OptionalSubjectPolicyInspectionSchema,
  views: OptionalViewInspectionListSchema,
}) {}

const OperationsSchema = Schema.Array(OperationInspection)
const ResourcesSchema = Schema.Array(ResourceInspectionSchema)
const CommandsSchema = Schema.Struct({ local: OperationNamesSchema, remote: OperationNamesSchema })

interface Commands extends Schema.Schema.Type<typeof CommandsSchema> {}


class ApplicationInspection extends Schema.Class<ApplicationInspection>("ApplicationInspection")({
  application: Schema.String,
  commands: CommandsSchema,
  featureFlags: FeatureFlagsInspectionSchema,
  operations: OperationsSchema,
  resources: ResourcesSchema,
}) {}


const renderPolicies = (
  rules: Readonly<Partial<Record<string, Policy>>>,
) => {
  const definedRules = Record.filter(rules, Predicate.isNotUndefined)

  return Record.map(definedRules, Policy.render)
}

const inspectAuthorization = (authorization: InspectableResource["authorization"]) => {
  if (!Predicate.isTagged(authorization, "Policy")) return authorization

  const subject = schemaDocument(authorization.subject)
  const scope = Policy.render(authorization.scope)
  const allow = renderPolicies(authorization.allow)
  const inspection = PolicyInspectionSchema.make({ subject, scope, allow })
  const requirements = Option.fromNullishOr(authorization.require)

  return Option.match(requirements, {
    onNone: Function.constant(inspection),
    onSome: (require) => PolicyInspectionSchema.make(Struct.assign(inspection, { require })),
  })
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
  const version = Option.fromNullishOr(definition.version)
  const transitions = pipe(definition.transitions, Option.fromNullishOr, Option.map(Struct.get("inspection")))
  const hasContract = (operation: InspectableResource["operations"][number]) => Record.has(definition.contracts, operation)
  const operations = Array.filter(definition.operations, hasContract)

  const inspection = ResourceInspectionSchema.make({
    name: definition.name,
    operations,
    schema,
    creation: definition.creation,
    list: definition.list,
    authorization,
    storage,
  })

  const withVersion = Option.match(version, {
    onNone: Function.constant(inspection),
    onSome: (value) => ResourceInspectionSchema.make(Struct.assign(inspection, { version: value })),
  })

  return Option.match(transitions, {
    onNone: Function.constant(withVersion),
    onSome: (value) => ResourceInspectionSchema.make(Struct.assign(withVersion, { transitions: value })),
  })
})

class InspectionError extends Schema.TaggedError<InspectionError>()("ApplicationInspectionError", {
  reason: Schema.String,
}) {}

const inspectSubjectPolicy = (policy: SubjectPolicy) => {
  const subject = schemaDocument(policy.subject)
  const rule = Policy.render(policy.expression)

  return SubjectPolicyInspection.make({ subject, rule, require: policy.require })
}


const inspectViews = (dependencies: Readonly<Pick<CommandLive["spec"], "dependencies">>["dependencies"]) => {
  const resolved = Command.dependencies(dependencies ?? [])

  const description = pipe(
    Match.type<(typeof resolved.readModels)[number]>(),
    Match.tagsExhaustive({
      ReadModelSpec: ReadModel.describe,
      CompiledReadModel: Struct.get<CompiledReadModel, "description">("description"),
    }),
  )

  return Array.map(resolved.readModels, description)
}

const inspectOperation = Effect.fn("ApplicationInspect.operation")(function* (
  procedure: RpcProcedure,
  command: Option.Option<Readonly<Pick<CommandLive["spec"], "policy" | "dependencies">>>,
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
  const nativePolicy = Context.getOption(procedure.annotations, AuthorizationRpc.policy)

  const policyFromCommand = flow(
    Struct.get<Readonly<Pick<CommandLive["spec"], "policy">>, "policy">("policy"),
    Option.fromNullishOr,
  )

  const policy = pipe(command, Option.flatMap(policyFromCommand), Option.orElse(Function.constant(nativePolicy)))
  const subjectPolicy = Option.map(policy, inspectSubjectPolicy)

  const viewsFromCommand = flow(
    Struct.get<Readonly<Pick<CommandLive["spec"], "dependencies">>, "dependencies">("dependencies"),
    inspectViews,
  )

  const views = Option.map(command, viewsFromCommand)
  const inspection = OperationInspection.make({ name: contract._tag, input, output, error })

  const withSubjectPolicy = Option.match(subjectPolicy, {
    onNone: Function.constant(inspection),
    onSome: (value) => Struct.assign(inspection, { subjectPolicy: value }),
  })

  const complete = Option.match(views, {
    onNone: Function.constant(withSubjectPolicy),
    onSome: (value) => Struct.assign(withSubjectPolicy, { views: value }),
  })

  return OperationInspection.make(complete)
})

// Inspection is a lossless projection because it preserves all bounded compile-time application metadata.
// The output is total because every operation, resource, and feature flag is required.
const inspectFeatureFlag = (flag: ApplicationIR["featureFlags"][number]) => FeatureFlagInspection.make(flag)

export const ApplicationInspect = {
  describe: Effect.fn("ApplicationInspect.describe")(function* (
    application: InspectableApplication,
    selected: Option.Option<string> = Option.none(),
    localCommands: ReadonlyArray<string> = ["serve", "inspect"],
  ) {
    const commandEntry = (command: ApplicationIR["commands"][number]) => Tuple.make(command.spec.name, command.spec)
    const commandEntries = Array.map(application.commands, commandEntry)
    const commandIndex = HashMap.fromIterable(commandEntries)
    const requests = application.group.requests.values()
    const procedures = Array.fromIterable(requests)

    const inspectProcedure = (procedure: RpcProcedure) => {
      const command = HashMap.get(commandIndex, procedure._tag)

      return inspectOperation(procedure, command)
    }

    const inspected = yield* Effect.forEach(procedures, inspectProcedure, { concurrency: 1 })
    const remote = Array.map(inspected, Struct.get("name"))

    const selectedOperations = Option.match(selected, {
      onNone: Function.constant(inspected),
      onSome: (name) => {
        const selectedNameEquals = Equivalence.strictEqual<string>()
        const selectedOperation = (operation: OperationInspection) => selectedNameEquals(operation.name, name)

        return Array.filter(inspected, selectedOperation)
      },
    })

    const commands = CommandsSchema.make({ local: localCommands, remote })
    const featureFlags = Array.map(application.featureFlags, inspectFeatureFlag)
    const resources = yield* Effect.forEach(application.resources, inspectResource, { concurrency: 1 })

    return ApplicationInspection.make({
      application: application.name,
      featureFlags,
      commands,
      operations: selectedOperations,
      resources,
    })
  }),
}
