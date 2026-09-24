import { Array, Function, Match, Option, Record, Schema, pipe } from "effect"
import type { TableRelationsInput } from "./table-relation-input.ts"
import type { TableFieldName } from "./table-relations.ts"
import type { StructSchema } from "./domain.ts"
import type { AuthorizationDefinition } from "./authorization-model.ts"
import type { TransitionMachine } from "./transitions.ts"

import type {
  CreationSources,
  ListPolicy,
  ResourceCapability,
  ResourceOperations,
} from "./resource-model.ts"

export const CreationSourceSchema = Schema.Union([
  Schema.TaggedStruct("Input", {}),
  Schema.TaggedStruct("Default", {
    value: Schema.Unknown,
  }),
  Schema.TaggedStruct("Generated", {
    token: Schema.Literals(["uuidV7", "now"]),
  }),
  Schema.TaggedStruct("Subject", {
    operand: Schema.Unknown,
  }),
])

type SourceKeys<
  Sources,
  Tag extends Schema.Schema.Type<typeof CreationSourceSchema>["_tag"],
> = {
  readonly [Key in keyof Sources]-?:
    Extract<NonNullable<Sources[Key]>, { readonly _tag: Tag }> extends never ? never : Key
}[keyof Sources]

type DefaultsFrom<Sources> = {
  readonly [Key in SourceKeys<Sources, "Default">]:
    Extract<NonNullable<Sources[Key]>, { readonly _tag: "Default" }> extends
      { readonly value: infer Value } ? Value : never
}

type GeneratedFrom<Sources> = {
  readonly [Key in SourceKeys<Sources, "Generated">]:
    Extract<NonNullable<Sources[Key]>, { readonly _tag: "Generated" }> extends
      { readonly token: infer Token } ? Token : never
}

type SubjectFrom<Sources> = {
  readonly [Key in SourceKeys<Sources, "Subject">]:
    Extract<NonNullable<Sources[Key]>, { readonly _tag: "Subject" }> extends
      { readonly operand: infer Operand } ? Operand : never
}

type CreationSourcesFrom<Capability> =
  Capability extends { readonly sources: infer Sources } ? Sources : {}

type CreationPolicyFrom<Capability> = {
  readonly [Key in "defaults" | "generated" | "fromSubject"]:
    Key extends "defaults" ? DefaultsFrom<CreationSourcesFrom<Capability>>
      : Key extends "generated" ? GeneratedFrom<CreationSourcesFrom<Capability>>
        : SubjectFrom<CreationSourcesFrom<Capability>>
} & (
  Capability extends { readonly publish: false }
    ? Readonly<{ publish: false }>
    : unknown
)

type DeclaredResourceOperations<
  Capabilities extends ReadonlyArray<ResourceCapability>,
> = {
  readonly [Capability in Capabilities[number] as Lowercase<Capability["_tag"]>]:
    Capability extends { readonly _tag: "Create" }
      ? CreationPolicyFrom<Capability>
      : Capability extends { readonly _tag: "List" }
        ? Omit<Capability, "_tag">
        : true
}

type CompleteResourceOperations<
  S extends StructSchema,
  Auth extends AuthorizationDefinition,
  Capabilities extends ReadonlyArray<ResourceCapability>,
  Declared extends Partial<ResourceOperations<S, Auth>> =
    DeclaredResourceOperations<Capabilities>,
> = Omit<ResourceOperations<S, Auth>, keyof Declared> & Declared

const CreationDefaultsSchema = Schema.Record(Schema.String, Schema.Unknown)
const CreationGeneratedFieldsSchema = Schema.Record(Schema.String, Schema.Literals(["uuidV7", "now"]))
const CreationFromSubjectSchema = Schema.Record(Schema.String, Schema.Unknown)
const CreationPublishSchema = Schema.optionalKey(Schema.Literal(false))

class CreationOperation extends Schema.Class<CreationOperation>("CreationOperation")({
  defaults: CreationDefaultsSchema,
  generated: CreationGeneratedFieldsSchema,
  fromSubject: CreationFromSubjectSchema,
  publish: CreationPublishSchema,
}) {}

const emptyCreationOperation = CreationOperation.make({
  defaults: {},
  generated: {},
  fromSubject: {},
})

const creationOperation = (
  capability: Extract<ResourceCapability, { readonly _tag: "Create" }>,
) => {
  const sources = capability.sources ?? {}
  const entries: ReadonlyArray<readonly [string, Schema.Schema.Type<typeof CreationSourceSchema>]> = Record.toEntries(sources)

  const operation = Array.reduce(entries, emptyCreationOperation, (state, [field, source]) =>
    pipe(
      Match.value(source),
      Match.tagsExhaustive({
        Input: () => state,
        Default: ({ value }) => CreationOperation.make({
          ...state,
          defaults: Record.set(state.defaults, field, value),
        }),
        Generated: ({ token }) => CreationOperation.make({
          ...state,
          generated: Record.set(state.generated, field, token),
        }),
        Subject: ({ operand }) => CreationOperation.make({
          ...state,
          fromSubject: Record.set(state.fromSubject, field, operand),
        }),
      }),
    )
  )

  const publish = Option.fromNullishOr(capability.publish)

  return Option.match(publish, {
    onNone: Function.constant(operation),
    onSome: (publish) => CreationOperation.make({ ...operation, publish }),
  })
}

const operationEntry = pipe(
  Match.type<ResourceCapability>(),
  Match.tagsExhaustive({
    Get: () => ["get", true] as const,
    List: ({ _tag: _, ...policy }) => ["list", policy] as const,
    Create: (capability) => ["create", creationOperation(capability)] as const,
    Update: () => ["update", true] as const,
    Remove: () => ["remove", true] as const,
    Patch: () => ["patch", true] as const,
    Transition: () => ["transition", true] as const,
  }),
)

interface ResourceReference<
  Target extends ResourceSpec = ResourceSpec,
> {
  readonly resource: Target
  readonly fields: ReadonlyArray<string>
}

type TableForeignKeyInput<Fields extends string> =
  NonNullable<TableRelationsInput<Fields>["foreignKeys"]>[number]

type ResourceRelationsInput<Fields extends string = string> =
  Omit<TableRelationsInput<Fields>, "foreignKeys">
  & Readonly<Partial<{
    foreignKeys: ReadonlyArray<
      Omit<TableForeignKeyInput<Fields>, "references">
      & Readonly<{ references: ResourceReference }>
    >
  }>>

export type ResourceSpec = Readonly<{
  readonly _tag: "ResourceSpec"
  readonly name: string
  readonly schema: StructSchema
  readonly authorization: AuthorizationDefinition
  readonly capabilities: ReadonlyArray<ResourceCapability>
}> & Readonly<Partial<{
  storage: StructSchema
  relations:
    | ResourceRelationsInput
    | TableRelationsInput
  version: string
  transitions: TransitionMachine
}>>

type DefinitionSchema<Definition> =
  Definition extends { readonly schema: infer S extends StructSchema } ? S : never

type DefinitionStorage<Definition> =
  Definition extends { readonly storage: infer Storage extends StructSchema }
    ? Storage
    : DefinitionSchema<Definition>

type DefinitionVersion<Definition> =
  Definition extends { readonly version: infer Version extends string }
    ? Version & Extract<keyof DefinitionSchema<Definition>["fields"], string>
    : undefined

type DefinitionTransition<Definition> =
  Definition extends { readonly transitions: infer Transition extends TransitionMachine }
    ? Transition
    : undefined

type DefinedResource<Definition> =
  Readonly<Definition> & Pick<ResourceSpec, "_tag">

type CapabilityValidation<
  Capability,
  S extends StructSchema,
  Auth extends AuthorizationDefinition,
> = Capability extends { readonly _tag: "Create" }
  ? Capability extends { readonly sources: infer Sources }
    ? Sources extends CreationSources<S, Auth> ? unknown : never
    : unknown
  : Capability extends { readonly _tag: "List" }
    ? Omit<Capability, "_tag"> extends ListPolicy<S> ? unknown : never
    : Capability extends ResourceCapability ? unknown : never

type CapabilitiesValidation<
  Capabilities,
  S extends StructSchema,
  Auth extends AuthorizationDefinition,
> = Capabilities extends readonly [
  infer Head extends ResourceCapability,
  ...infer Tail extends ReadonlyArray<ResourceCapability>,
]
  ? [CapabilityValidation<Head, S, Auth>] extends [never]
    ? never
    : CapabilitiesValidation<Tail, S, Auth>
  : Capabilities extends ReadonlyArray<ResourceCapability> ? unknown : never

type RelationEntryValidation<Entry, Field extends string> =
  Entry extends { readonly fields: ReadonlyArray<infer Local> }
    ? Exclude<Local, Field> extends never
      ? Entry extends { readonly scope: ReadonlyArray<infer Scope> }
        ? Exclude<Scope, Field> extends never ? unknown : never
        : unknown
      : never
    : never

type RelationEntriesValidation<Entries, Field extends string> =
  Entries extends readonly [infer Head, ...infer Tail]
    ? [RelationEntryValidation<Head, Field>] extends [never]
      ? never
      : RelationEntriesValidation<Tail, Field>
    : Entries extends ReadonlyArray<unknown> ? unknown : never

type RelationsValidation<Definition> =
  Definition extends { readonly relations: infer Relations }
    ? (
      Relations extends { readonly unique: infer Unique }
        ? RelationEntriesValidation<Unique, TableFieldName<DefinitionStorage<Definition>>>
        : unknown
    ) & (
      Relations extends { readonly indexes: infer Indexes }
        ? RelationEntriesValidation<Indexes, TableFieldName<DefinitionStorage<Definition>>>
        : unknown
    ) & (
      Relations extends { readonly foreignKeys: infer ForeignKeys }
        ? RelationEntriesValidation<ForeignKeys, TableFieldName<DefinitionStorage<Definition>>>
        : unknown
    )
    : unknown

type DefinitionValidation<Definition> =
  Definition extends Readonly<{
    name: string
    schema: infer S extends StructSchema
    authorization: infer Auth extends AuthorizationDefinition
    capabilities: infer Capabilities
  }>
    ? CapabilitiesValidation<Capabilities, S, Auth> & RelationsValidation<Definition>
    : never

const define = <
  const Definition extends Readonly<{
    name: string
    schema: StructSchema
    authorization: AuthorizationDefinition
    capabilities: ReadonlyArray<ResourceCapability>
  }> & Readonly<Partial<{
    storage: StructSchema
    relations: ResourceRelationsInput | TableRelationsInput
    version: string
    transitions: TransitionMachine
  }>>,
>(
  definition: Definition,
  ..._validation: [DefinitionValidation<Definition>] extends [never]
    ? readonly [invalidDefinition: never]
    : readonly []
): DefinedResource<Definition> => {
  const capabilities = Object.freeze([...definition.capabilities])

  return Object.freeze({
    ...definition,
    _tag: "ResourceSpec" as const,
    capabilities,
  })
}

export {
  type CompleteResourceOperations,
  type DeclaredResourceOperations,
  type DefinitionStorage,
  type DefinitionTransition,
  type DefinitionVersion,
  define,
  operationEntry,
  type ResourceReference,
}
