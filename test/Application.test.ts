import { expect, it } from "@effect/vitest"
import { Effect, Function, Schema, pipe } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Application, Part } from "effect-domains/application"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { Command } from "effect-domains/command"

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

  expect(() => pipe(Application.compile(collision), Effect.runSync)).toThrow()

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

  expect(() => pipe(Application.compile(commandCollision), Effect.runSync)).toThrow()
})

it.effect("validates foreign keys across sibling applications by exact descriptor", Effect.fn("Application.foreignKeys")(function* () {
  const ParentSchema = Schema.Struct({ name: Schema.String })

  interface Parent extends Schema.Schema.Type<typeof ParentSchema> {}

  const ChildSchema = Schema.Struct({ parentId: Schema.String })

  interface Child extends Schema.Schema.Type<typeof ChildSchema> {}

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

  const parentParts = [Part.resource(Parent)]
  const parent = Application.define({ name: "exact-parent", parts: parentParts })
  const childParts = [Part.resource(Child)]
  const child = Application.define({ name: "exact-child", parts: childParts })
  const validParts = [Part.application(parent), Part.application(child)]
  const valid = Application.define({ name: "exact-valid", parts: validParts })
  const replacementParts = [Part.resource(Replacement)]
  const replacement = Application.define({ name: "exact-replacement", parts: replacementParts })
  const invalidParts = [Part.application(replacement), Part.application(child)]
  const invalid = Application.define({ name: "exact-invalid", parts: invalidParts })

  yield* Application.compile(valid)

  const rejected = yield* pipe(Application.compile(invalid), Effect.exit)

  expect(rejected._tag).toBe("Failure")
}))

class ApplicationCommandUnavailable extends Schema.TaggedError<ApplicationCommandUnavailable>()(
  "ApplicationCommandUnavailable",
  {},
) {}

it.effect("validates command dependencies across sibling applications by descriptor identity", Effect.fn("Application.dependencies")(function* () {
  const RowSchema = Schema.Struct({ value: Schema.String })

  interface Row extends Schema.Schema.Type<typeof RowSchema> {}

  const dependency = (name: string) => Resource.define({
    name,
    schema: RowSchema,
    authorization: Authorization.public,
    capabilities: [],
  })

  const ResourceDependency = dependency("resource_dependency")
  const TableDependency = dependency("table_dependency")
  const Replacement = dependency("resource_dependency")
  const tableDependency = Resource.table(TableDependency)

  const commandSpec = Command.define({
    name: "dependency.command",
    success: Schema.Void,
    dependencies: [ResourceDependency, tableDependency],
    unavailable: ApplicationCommandUnavailable,
  })

  const command = Command.implement(commandSpec, Function.constant(Effect.void))
  const commands = Command.bundle(command)

  const dependencyParts = [
    Part.resource(ResourceDependency),
    Part.resource(TableDependency),
  ]

  const dependencies = Application.define({
    name: "dependencies",
    parts: dependencyParts,
  })

  const commandParts = [Part.command(commands)]
  const commandApplication = Application.define({ name: "commands", parts: commandParts })
  const validParts = [Part.application(dependencies), Part.application(commandApplication)]
  const valid = Application.define({ name: "dependencies-valid", parts: validParts })

  const replacementParts = [
    Part.resource(Replacement),
    Part.resource(TableDependency),
  ]

  const replacements = Application.define({
    name: "replacements",
    parts: replacementParts,
  })

  const invalidParts = [Part.application(replacements), Part.application(commandApplication)]
  const invalid = Application.define({ name: "dependencies-invalid", parts: invalidParts })

  yield* Application.compile(valid)

  const rejected = yield* pipe(Application.compile(invalid), Effect.exit)

  expect(rejected._tag).toBe("Failure")
}))

