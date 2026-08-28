import assert from "node:assert/strict"
import { Effect, Layer, Option, Schema } from "effect"
import {
  type CompiledEntity,
  type EntityService,
} from "../src/Persistence.ts"

export const adapterContract = <
  const Name extends string,
  S extends Schema.Struct<Schema.Struct.Fields>,
  K extends Extract<keyof S["fields"], string>,
>(
  entity: CompiledEntity<Name, S, K>,
  adapter: Layer.Layer<EntityService<Name, S, K>>,
  fixture: Readonly<{
    original: S["Type"]
    replacement: S["Type"]
    missingKey: S["fields"][K]["Type"]
  }>,
) =>
  Effect.gen(function* () {
    const keyOf = (value: S["Type"]): S["fields"][K]["Type"] =>
      (value as Record<K, S["fields"][K]["Type"]>)[entity.primaryKey]

    const created = yield* entity.create(fixture.original)
    yield* Effect.sync(() => assert.deepStrictEqual(created, fixture.original))

    const found = yield* entity.read(keyOf(created))
    yield* Effect.sync(() => {
      assert.ok(Option.isSome(found))
      assert.deepStrictEqual(found.value, fixture.original)
    })

    const updated = yield* entity.update(fixture.replacement)
    yield* Effect.sync(() => {
      assert.ok(Option.isSome(updated))
      assert.deepStrictEqual(updated.value, fixture.replacement)
    })

    const missingRead = yield* entity.read(fixture.missingKey)
    yield* Effect.sync(() => assert.ok(Option.isNone(missingRead)))

    const missingUpdate = yield* entity.update({
      ...fixture.replacement,
      [entity.primaryKey]: fixture.missingKey,
    } as S["Type"])
    yield* Effect.sync(() => assert.ok(Option.isNone(missingUpdate)))

    const deleted = yield* entity.delete(keyOf(fixture.original))
    yield* Effect.sync(() => assert.equal(deleted, true))

    const afterDelete = yield* entity.read(keyOf(fixture.original))
    yield* Effect.sync(() => assert.ok(Option.isNone(afterDelete)))

    const deletedAgain = yield* entity.delete(keyOf(fixture.original))
    yield* Effect.sync(() => assert.equal(deletedAgain, false))
  }).pipe(Effect.provide(adapter))
