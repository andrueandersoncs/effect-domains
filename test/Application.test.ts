import { expect, it } from "@effect/vitest"
import { Array, Effect, Function, Schema, Struct } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Application, Part } from "effect-domains/application"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { Command } from "effect-domains/command"
import { ReadModel } from "effect-domains/read-model"
import { Table } from "effect-domains/table"

it("rejects table and command collisions across nested applications", () => {
  const RowSchema = Schema.Struct({ value: Schema.String })
  interface Row extends Schema.Schema.Type<typeof RowSchema> {}

  const resource = Resource.define({
    name: "shared",
    schema: RowSchema,
    authorization: Authorization.public,
    capabilities: [],
  })

  const storageParts = [Part.resource(resource)]
  const storage = Application.define({ name: "storage", parts: storageParts })
  const nestedStorageParts = [Part.application(storage)]
  const nestedStorage = Application.define({ name: "nested-storage", parts: nestedStorageParts })
  const collisionParts = [Part.application(storage), Part.application(nestedStorage)]
  const collision = Application.define({ name: "collision", parts: collisionParts })
  expect(() => Application.compile(collision)).toThrow()

  const ping = Rpc.make("ping")
  const group = RpcGroup.make(ping)
  const handlers = group.toLayer({ ping: Function.constant(Effect.void) })
  const commandParts = [Part.native({ group, handlers })]

  const commands = Application.define({
    name: "commands",
    parts: commandParts,
  })

  const nestedCommandParts = [Part.application(commands)]

  const nestedCommands = Application.define({
    name: "nested-commands",
    parts: nestedCommandParts,
  })

  const commandCollisionParts = [Part.application(commands), Part.application(nestedCommands)]
  const commandCollision = Application.define({ name: "collision", parts: commandCollisionParts })
  expect(() => Application.compile(commandCollision)).toThrow()
})

it("validates foreign keys against the exact registered table descriptor", () => {
  const ParentSchema = Schema.Struct({ name: Schema.String })
  const ChildSchema = Schema.Struct({ parentId: Schema.String })

  const Parent = Resource.define({
    name: "exact_parents",
    schema: ParentSchema,
    authorization: Authorization.public,
    capabilities: [],
  })

  const Replacement = Resource.define({
    name: "exact_parents",
    schema: ParentSchema,
    authorization: Authorization.public,
    capabilities: [],
  })

  const ParentIdReference = Resource.reference(Parent, ["id"])

  const Child = Resource.define({
    name: "exact_children",
    schema: ChildSchema,
    authorization: Authorization.public,
    capabilities: [],
    relations: {
      foreignKeys: [{ fields: ["parentId"], references: ParentIdReference }],
    },
  })

  const validParts = [Part.resource(Parent), Part.resource(Child)]
  const valid = Application.define({ name: "exact-valid", parts: validParts })
  const makeValid = () => Application.compile(valid)
  const invalidParts = [Part.resource(Replacement), Part.resource(Child)]
  const invalid = Application.define({ name: "exact-invalid", parts: invalidParts })
  const makeInvalid = () => Application.compile(invalid)
  const validExpectation = expect(makeValid)
  const invalidExpectation = expect(makeInvalid)
  validExpectation.not.toThrow()
  invalidExpectation.toThrow("references unregistered table exact_parents")
})

class ApplicationCommandUnavailable extends Schema.TaggedError<ApplicationCommandUnavailable>()(
  "ApplicationCommandUnavailable",
  {},
) {}

it("validates resource and table command dependencies by descriptor identity", () => {
  const RowSchema = Schema.Struct({ value: Schema.String })

  const ResourceDependency = Resource.define({
    name: "resource_dependency",
    schema: RowSchema,
    authorization: Authorization.public,
    capabilities: [],
  })

  const TableDependency = Resource.define({
    name: "table_dependency",
    schema: RowSchema,
    authorization: Authorization.public,
    capabilities: [],
  })

  const Replacement = Resource.define({
    name: "resource_dependency",
    schema: RowSchema,
    authorization: Authorization.public,
    capabilities: [],
  })

  const tableDependency = Resource.table(TableDependency)

  const commandSpec = Command.define({
    name: "dependency.command",
    success: Schema.Void,
    dependencies: [ResourceDependency, tableDependency],
    unavailable: ApplicationCommandUnavailable,
  })

  const command = Command.implement(commandSpec, Function.constant(Effect.void))
  const commands = Command.bundle(command)

  const validParts = [
    Part.resource(ResourceDependency),
    Part.resource(TableDependency),
    Part.command(commands),
  ]

  const valid = Application.define({ name: "dependencies-valid", parts: validParts })
  const makeValid = () => Application.compile(valid)

  const invalidParts = [
    Part.resource(Replacement),
    Part.resource(TableDependency),
    Part.command(commands),
  ]

  const invalid = Application.define({ name: "dependencies-invalid", parts: invalidParts })
  const makeInvalid = () => Application.compile(invalid)
  const validExpectation = expect(makeValid)
  const invalidExpectation = expect(makeInvalid)
  validExpectation.not.toThrow()
  invalidExpectation.toThrow("reads unregistered table resource_dependency")
})

it("keeps authoring specifications free of derived runtime products", () => {
  const RowSchema = Schema.Struct({ value: Schema.String })

  const resource = Resource.define({
    name: "intent_only",
    schema: RowSchema,
    authorization: Authorization.public,
    capabilities: [],
  })

  const command = Command.define({
    name: "intent.command",
    success: Schema.Void,
    unavailable: ApplicationCommandUnavailable,
  })

  const modelSources = ReadModel.sources({ value: resource })

  const model = ReadModel.define({
    tables: modelSources,
    from: "value",
    joins: [],
    select: { value: ["value", "value"] },
  })

  const applicationParts = [Part.resource(resource)]

  const application = Application.define({
    name: "intent",
    parts: applicationParts,
  })

  const forbidden = ["table", "repository", "contracts", "group", "handlers", "handler", "execute"]

  const specificationKeys = [
    Struct.keys(resource),
    Struct.keys(command),
    Struct.keys(model),
    Struct.keys(application),
  ]

  const hasForbiddenProperty = (keys: ReadonlyArray<string>) => {
    const isForbidden = (property: string) => Array.contains(keys, property)
    return Array.some(forbidden, isForbidden)
  }

  const forbiddenProperties = Array.map(specificationKeys, hasForbiddenProperty)
  expect(forbiddenProperties).toEqual([false, false, false, false])
})
