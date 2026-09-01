import * as assert from "@effect/vitest/utils"
import { Effect, Option } from "effect"

/**
 *
 * Scope: public
 *
 * When to use: Adapter tests share this contract because authored CRUD query
 * sets need database-neutral behavior.
 *
 * Example:
 * ```ts
 * import { adapterContract } from "./effects.ts"
 *
 * const verification = adapterContract(options)
 * ```
 *
 */
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
  create: Readonly<{
    execute: (input: Entity) => Effect.Effect<Entity, CreateError, CreateRequirements>
  }>
  read: Readonly<{
    execute: (input: Key) => Effect.Effect<
      Option.Option<Entity>,
      ReadError,
      ReadRequirements
    >
  }>
  update: Readonly<{
    execute: (input: Entity) => Effect.Effect<
      Option.Option<Entity>,
      UpdateError,
      UpdateRequirements
    >
  }>
  delete: Readonly<{
    execute: (input: Key) => Effect.Effect<boolean, DeleteError, DeleteRequirements>
  }>
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
