import * as assert from "@effect/vitest/utils"
import { Effect, Option } from "effect"

type Operation<Input, Output, Error, Requirements> = Readonly<{
  execute: (input: Input) => Effect.Effect<Output, Error, Requirements>
}>

/**

Use when: verifying a database adapter because authored CRUD query sets must
share database-neutral behavior.

Example: yield `adapterContract(options)` from an adapter integration test.

**/
export const adapterContract = Effect.fn("AdapterContract.verify")(function* <
  Entity,
  Key,
  CreateError,
  CreateRequirements,
  ReadError,
  ReadRequirements,
  UpdateError,
  UpdateRequirements,
  DeleteError,
  DeleteRequirements,
>(options: Readonly<{
  keyOf: (entity: Entity) => Key
  original: Entity
  replacement: Entity
  missingReplacement: Entity
  missingKey: Key
  create: Operation<Entity, Entity, CreateError, CreateRequirements>
  read: Operation<
    Key,
    Option.Option<Entity>,
    ReadError,
    ReadRequirements
  >
  update: Operation<
    Entity,
    Option.Option<Entity>,
    UpdateError,
    UpdateRequirements
  >
  delete: Operation<Key, boolean, DeleteError, DeleteRequirements>
}>) {
  const created = yield* options.create.execute(options.original)
  assert.deepStrictEqual(created, options.original)

  const createdKey = options.keyOf(created)
  const found = yield* options.read.execute(createdKey)
  const foundIsSome = Option.isSome(found)

  assert.assertTrue(foundIsSome)
  assert.deepStrictEqual(found.value, options.original)

  const updated = yield* options.update.execute(options.replacement)
  const updatedIsSome = Option.isSome(updated)

  assert.assertTrue(updatedIsSome)
  assert.deepStrictEqual(updated.value, options.replacement)

  const missingRead = yield* options.read.execute(options.missingKey)
  const missingReadIsNone = Option.isNone(missingRead)

  assert.assertTrue(missingReadIsNone)

  const missingUpdate = yield* options.update.execute(
    options.missingReplacement,
  )

  const missingUpdateIsNone = Option.isNone(missingUpdate)

  assert.assertTrue(missingUpdateIsNone)

  const originalKey = options.keyOf(options.original)
  const deleted = yield* options.delete.execute(originalKey)

  assert.strictEqual(deleted, true)

  const afterDelete = yield* options.read.execute(originalKey)
  const afterDeleteIsNone = Option.isNone(afterDelete)

  assert.assertTrue(afterDeleteIsNone)

  const deletedAgain = yield* options.delete.execute(originalKey)
  assert.strictEqual(deletedAgain, false)
})
