import { expect, it } from "@effect/vitest"
import { Effect, Function, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Application } from "effect-domains/application"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"
import { Operation } from "effect-domains/operation"
import { Table } from "effect-domains/table"

it("rejects table and operation collisions across nested applications", () => {
  const RowSchema = Schema.Struct({ value: Schema.String })
  interface Row extends Schema.Schema.Type<typeof RowSchema> {}

  const resource = Resource.make({
    name: "shared",
    schema: RowSchema,
    authorization: Authorization.public,
    operations: {},
  })

  const storage = Application.make({ name: "storage", parts: [resource] })
  const nestedStorage = Application.make({ name: "nested-storage", parts: [storage] })
  expect(() => Application.make({ name: "collision", parts: [storage, nestedStorage] })).toThrow()

  const ping = Rpc.make("ping")
  const group = RpcGroup.make(ping)
  const handlers = group.toLayer({ ping: Function.constant(Effect.void) })
  const commands = Application.make({ name: "commands", parts: [{ group, handlers }] })
  const nestedCommands = Application.make({ name: "nested-commands", parts: [commands] })
  expect(() => Application.make({ name: "collision", parts: [commands, nestedCommands] })).toThrow()
})

it("validates foreign keys against the exact registered table descriptor", () => {
  const ParentSchema = Schema.Struct({ name: Schema.String })
  const ChildSchema = Schema.Struct({ parentId: Schema.String })

  const Parent = Resource.make({
    name: "exact_parents",
    schema: ParentSchema,
    authorization: Authorization.public,
    operations: {},
  })

  const Replacement = Resource.make({
    name: "exact_parents",
    schema: ParentSchema,
    authorization: Authorization.public,
    operations: {},
  })

  const ParentIdReference = Table.reference(Parent.table, ["id"])

  const Child = Resource.make({
    name: "exact_children",
    schema: ChildSchema,
    authorization: Authorization.public,
    operations: {},
    relations: {
      foreignKeys: [{ fields: ["parentId"], references: ParentIdReference }],
    },
  })

  const makeValid = () => Application.make({ name: "exact-valid", parts: [Parent, Child] })
  const makeInvalid = () => Application.make({ name: "exact-invalid", parts: [Replacement, Child] })
  const validExpectation = expect(makeValid)
  const invalidExpectation = expect(makeInvalid)
  validExpectation.not.toThrow()
  invalidExpectation.toThrow("references unregistered table exact_parents")
})

class ApplicationOperationUnavailable extends Schema.TaggedError<ApplicationOperationUnavailable>()(
  "ApplicationOperationUnavailable",
  {},
) {}

it("validates resource and table operation dependencies by descriptor identity", () => {
  const RowSchema = Schema.Struct({ value: Schema.String })

  const ResourceDependency = Resource.make({
    name: "resource_dependency",
    schema: RowSchema,
    authorization: Authorization.public,
    operations: {},
  })

  const TableDependency = Resource.make({
    name: "table_dependency",
    schema: RowSchema,
    authorization: Authorization.public,
    operations: {},
  })

  const Replacement = Resource.make({
    name: "resource_dependency",
    schema: RowSchema,
    authorization: Authorization.public,
    operations: {},
  })

  const operation = Operation.make({
    name: "dependency.operation",
    success: Schema.Void,
    dependencies: [ResourceDependency, TableDependency.table],
    unavailable: ApplicationOperationUnavailable,
    handler: Function.constant(Effect.void),
  })

  const operations = Operation.bundle(operation)

  const makeValid = () => Application.make({
    name: "dependencies-valid",
    parts: [ResourceDependency, TableDependency, operations],
  })

  const makeInvalid = () => Application.make({
    name: "dependencies-invalid",
    parts: [Replacement, TableDependency, operations],
  })

  const validExpectation = expect(makeValid)
  const invalidExpectation = expect(makeInvalid)
  validExpectation.not.toThrow()
  invalidExpectation.toThrow("reads unregistered table resource_dependency")
})
