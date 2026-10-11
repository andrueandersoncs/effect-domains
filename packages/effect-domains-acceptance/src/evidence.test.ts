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

const catalog = { id: "c", revision: "1", provenance: "test", approval: "approved" as const, imports: [{ alias: "shared", catalog: "shared", revision: "1" }], approvals: [], actors: [], contexts: [], needs: [], capabilities: [], features: [], textFixtures: [], rubrics: [], requirements: [], stories: [], scenarios: [] }

const shared = { ...catalog, id: "shared", imports: [], provenance: "shared obligations" }

// The edited import keeps its revision because the build identity must notice content changes a revision bump would otherwise announce.
const editedShared = { ...shared, provenance: "shared obligations, silently edited" }

const unrelated = { ...shared, id: "unrelated" }

const identifyTest = Effect.gen(function* () {
  const evidence = yield* RunEvidence
  const build = yield* evidence.identify(catalog, [unrelated, shared])
  const reordered = yield* evidence.identify(catalog, [shared])
  const edited = yield* evidence.identify(catalog, [editedShared, unrelated])
  const paths = Array.map(build.files, Struct.get("path"))
  const imported = Array.map(build.importedCatalogs, Struct.get("id"))
  const unchangedHash = Equal.equals(edited.catalogHash, build.catalogHash)

  expect(build.application).toBe("acceptance-test")
  expect(build.effect).toBe("4.0.0-rc.112")
  expect(paths).toEqual(["packages/effect-domains-acceptance/package.json", "packages/effect-domains-acceptance/tsconfig.json"])
  expect(imported).toEqual(["shared"])
  expect(reordered.catalogHash).toBe(build.catalogHash)
  expect(unchangedHash).toBe(false)
  expect(edited.sha256).toBe(build.sha256)
})

const layer = evidenceLayer(identity)

const provided = <A, E, R>(test: Effect.Effect<A, E, R>) => pipe(test, Effect.provide(layer))

const roundTrip = provided(roundTripTest)
const identified = provided(identifyTest)

it.effect("saved evidence reads back encoded and retained secrets are reported by relative path", Function.constant(roundTrip))
it.effect("the build identity hashes the declared files and covers exactly the pinned imports' content", Function.constant(identified))
