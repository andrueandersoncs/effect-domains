import assert from "node:assert/strict"
import { Effect, Option } from "effect"

type Operation<Input, Output, Error, Requirements> = Readonly<{
  execute: (input: Input) => Effect.Effect<Output, Error, Requirements>
}>

/** Validates the database-neutral behavior of an authored CRUD query set. */
export const adapterContract = <
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
}>) =>
  Effect.gen(function* () {
    const created = yield* options.create.execute(options.original)
    assert.deepStrictEqual(created, options.original)

    const found = yield* options.read.execute(options.keyOf(created))
    assert.ok(Option.isSome(found))
    assert.deepStrictEqual(found.value, options.original)

    const updated = yield* options.update.execute(options.replacement)
    assert.ok(Option.isSome(updated))
    assert.deepStrictEqual(updated.value, options.replacement)

    const missingRead = yield* options.read.execute(options.missingKey)
    assert.ok(Option.isNone(missingRead))

    const missingUpdate = yield* options.update.execute(
      options.missingReplacement,
    )
    assert.ok(Option.isNone(missingUpdate))

    const deleted = yield* options.delete.execute(options.keyOf(options.original))
    assert.equal(deleted, true)

    const afterDelete = yield* options.read.execute(options.keyOf(options.original))
    assert.ok(Option.isNone(afterDelete))

    const deletedAgain = yield* options.delete.execute(
      options.keyOf(options.original),
    )
    assert.equal(deletedAgain, false)
  })
