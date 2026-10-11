import { expect, it } from "@effect/vitest"
import { Array, Effect, Equal, Function, Redacted, Schema, Struct, pipe } from "effect"
import { join } from "node:path"
import { EvidenceIdentity, evidenceLayer } from "./evidence.ts"
import { RunEvidence } from "./model.ts"
import { scopedTemporaryDirectory } from "./server.ts"
import { TestApplication } from "./test-application.ts"

const identity = EvidenceIdentity.make({
  name: "acceptance-test",
  application: TestApplication,
  walkedRoots: [],
  builtRoots: [],
  files: ["packages/effect-domains-acceptance/package.json", "packages/effect-domains-acceptance/tsconfig.json"],
  effect: "4.0.0-rc.112",
})

const SavedTextSchema = Schema.Struct({ note: Schema.String })

interface SavedText extends Schema.Schema.Type<typeof SavedTextSchema> {}

const secret = Redacted.make("acceptance-secret-value")

const leaked: SavedText = SavedTextSchema.make({ note: "token acceptance-secret-value retained" })

const clean: SavedText = SavedTextSchema.make({ note: "nothing sensitive" })

const temporaryDirectory = scopedTemporaryDirectory("effect-domains-acceptance-evidence-")

const roundTripTest = Effect.gen(function* () {
  const evidence = yield* RunEvidence
  const directory = yield* temporaryDirectory
  const cleanPath = join(directory, "clean.json")
  const leakedPath = join(directory, "leaked.json")

  yield* evidence.save(cleanPath, SavedTextSchema, clean)
  yield* evidence.save(leakedPath, SavedTextSchema, leaked)

  const restored = yield* evidence.read(cleanPath)
  const leaks = yield* evidence.scan(directory, [secret])

  expect(restored).toEqual({ note: "nothing sensitive" })
  expect(leaks).toEqual(["leaked.json"])
})

const catalog = { id: "c", actors: [], requirements: [], stories: [], scenarios: [] }

const editedCatalog = { ...catalog, id: "edited" }

const identifyTest = Effect.gen(function* () {
  const evidence = yield* RunEvidence
  const build = yield* evidence.identify(catalog)
  const again = yield* evidence.identify(catalog)
  const edited = yield* evidence.identify(editedCatalog)
  const paths = Array.map(build.files, Struct.get("path"))
  const unchangedHash = Equal.equals(edited.catalogHash, build.catalogHash)
  const sharedHash = Equal.equals(build.sourceHash, build.bundleHash)

  expect(build.application).toBe("acceptance-test")
  expect(build.effect).toBe("4.0.0-rc.112")
  expect(paths).toEqual(["packages/effect-domains-acceptance/package.json", "packages/effect-domains-acceptance/tsconfig.json"])
  expect(again.catalogHash).toBe(build.catalogHash)
  expect(unchangedHash).toBe(false)
  expect(edited.sourceHash).toBe(build.sourceHash)
  expect(edited.bundleHash).toBe(build.bundleHash)
  expect(sharedHash).toBe(false)
})

const layer = evidenceLayer(identity)

const provided = <A, E, R>(test: Effect.Effect<A, E, R>) => pipe(test, Effect.provide(layer))

const roundTrip = provided(roundTripTest)
const identified = provided(identifyTest)

it.effect("saved evidence reads back encoded and retained secrets are reported by relative path", Function.constant(roundTrip))
it.effect("the build identity hashes sources, bundles, and the catalog separately", Function.constant(identified))
