import { expect, it } from "@effect/vitest"
import { Effect, Function, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Application } from "effect-domains/application"
import { Authorization } from "effect-domains/authorization"
import { Resource } from "effect-domains/resource"

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
