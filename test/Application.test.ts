import { expect, it } from "@effect/vitest"
import { Effect, Function, Schema } from "effect"
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
    capabilities: Resource.capabilities(),
  })

  const storage = Application.define({ name: "storage", parts: [Part.resource(resource)] })
  const nestedStorage = Application.define({ name: "nested-storage", parts: [Part.application(storage)] })
  expect(() => Application.compile(Application.define({
    name: "collision",
    parts: [Part.application(storage), Part.application(nestedStorage)],
  }))).toThrow()

  const ping = Rpc.make("ping")
  const group = RpcGroup.make(ping)
  const handlers = group.toLayer({ ping: Function.constant(Effect.void) })
  const commands = Application.define({
    name: "commands",
    parts: [Part.native({ group, handlers })],
  })
  const nestedCommands = Application.define({
    name: "nested-commands",
    parts: [Part.application(commands)],
  })
  expect(() => Application.compile(Application.define({
    name: "collision",
    parts: [Part.application(commands), Part.application(nestedCommands)],
  }))).toThrow()
})

it("validates foreign keys against the exact registered table descriptor", () => {
  const ParentSchema = Schema.Struct({ name: Schema.String })
  const ChildSchema = Schema.Struct({ parentId: Schema.String })

  const Parent = Resource.define({
    name: "exact_parents",
    schema: ParentSchema,
    authorization: Authorization.public,
    capabilities: Resource.capabilities(),
  })

  const Replacement = Resource.define({
    name: "exact_parents",
    schema: ParentSchema,
    authorization: Authorization.public,
    capabilities: Resource.capabilities(),
  })

  const ParentIdReference = Resource.reference(Parent, ["id"])

  const Child = Resource.define({
    name: "exact_children",
    schema: ChildSchema,
    authorization: Authorization.public,
    capabilities: Resource.capabilities(),
    relations: {
      foreignKeys: [{ fields: ["parentId"], references: ParentIdReference }],
    },
  })

  const makeValid = () => Application.compile(Application.define({
    name: "exact-valid",
    parts: [Part.resource(Parent), Part.resource(Child)],
  }))
  const makeInvalid = () => Application.compile(Application.define({
    name: "exact-invalid",
    parts: [Part.resource(Replacement), Part.resource(Child)],
  }))
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
    capabilities: Resource.capabilities(),
  })

  const TableDependency = Resource.define({
    name: "table_dependency",
    schema: RowSchema,
    authorization: Authorization.public,
    capabilities: Resource.capabilities(),
  })

  const Replacement = Resource.define({
    name: "resource_dependency",
    schema: RowSchema,
    authorization: Authorization.public,
    capabilities: Resource.capabilities(),
  })

  const commandSpec = Command.define({
    name: "dependency.command",
    success: Schema.Void,
    dependencies: [ResourceDependency, Resource.table(TableDependency)],
    unavailable: ApplicationCommandUnavailable,
  })
  const command = Command.implement(commandSpec, Function.constant(Effect.void))
  const commands = Command.bundle(command)

  const makeValid = () => Application.compile(Application.define({
    name: "dependencies-valid",
    parts: [
      Part.resource(ResourceDependency),
      Part.resource(TableDependency),
      Part.command(commands),
    ],
  }))

  const makeInvalid = () => Application.compile(Application.define({
    name: "dependencies-invalid",
    parts: [
      Part.resource(Replacement),
      Part.resource(TableDependency),
      Part.command(commands),
    ],
  }))

  const validExpectation = expect(makeValid)
  const invalidExpectation = expect(makeInvalid)
  validExpectation.not.toThrow()
  invalidExpectation.toThrow("reads unregistered table resource_dependency")
})

it("keeps authoring specifications free of derived runtime products", () => {
  const resource = Resource.define({
    name: "intent_only",
    schema: Schema.Struct({ value: Schema.String }),
    authorization: Authorization.public,
    capabilities: Resource.capabilities(),
  })
  const command = Command.define({
    name: "intent.command",
    success: Schema.Void,
    unavailable: ApplicationCommandUnavailable,
  })
  const model = ReadModel.define({
    tables: ReadModel.sources({ value: resource }),
    from: "value",
    joins: [],
    select: { value: ["value", "value"] },
  })
  const application = Application.define({
    name: "intent",
    parts: [Part.resource(resource)],
  })
  const forbidden = ["table", "repository", "contracts", "group", "handlers", "handler", "execute"]

  for (const specification of [resource, command, model, application]) {
    expect(forbidden.some((property) => Object.hasOwn(specification, property))).toBe(false)
  }
})
