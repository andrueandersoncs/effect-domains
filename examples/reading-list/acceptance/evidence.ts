import { Context, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { ApplicationInspect } from "effect-domains/application-inspect"
import { ReadingListApplication } from "../application.ts"
import { AcceptanceError } from "./model.ts"

export class RunEvidence extends Context.Service<RunEvidence, {
  save: (path: string, value: unknown) => Effect.Effect<void, AcceptanceError>
}>()("reading-list/acceptance/RunEvidence") {}

export const evidenceLayer = Layer.succeed(RunEvidence, {
  save: Effect.fn("Acceptance.evidence.save")(function* (path: string, value: unknown) {
    yield* Effect.tryPromise({
      try: async () => {
        const staged = `${path}.pending`
        await writeFile(staged, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
        await rename(staged, path)
      },
      catch: (error) => new AcceptanceError({ boundary: "evidence", message: String(error) }),
    })
  }),
})

export const directory = Effect.fn("Acceptance.evidence.directory")(function* (path: string) {
  yield* Effect.tryPromise({ try: () => mkdir(path, { recursive: true, mode: 0o700 }), catch: (error) => new AcceptanceError({ boundary: "evidence", message: String(error) }) })
  return path
})

export const buildIdentity = Effect.fn("Acceptance.buildIdentity")(function* (catalog: unknown) {
  const inspection = yield* ApplicationInspect.describe(ReadingListApplication)
  const identity = yield* Effect.tryPromise({
    try: async () => {
      const root = new URL("../../../", import.meta.url).pathname
      const files: string[] = []
      const walk = async (path: string): Promise<void> => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const filename = join(path, entry.name)
          if (entry.isDirectory()) await walk(filename)
          else if (/\.(ts|json|html|css)$/.test(entry.name)) files.push(filename)
        }
      }
      for (const path of ["packages/effect-domains/src", "apps/application-ui/src", "examples/reading-list/acceptance"]) await walk(join(root, path))
      for (const path of ["domain.ts", "resources.ts", "application.ts", "infrastructure.ts", "main.ts", "migrations.ts"]) files.push(join(root, "examples/reading-list", path))
      await walk(join(root, "examples/reading-list/migrations"))
      for (const path of ["bun.lock", "package.json", "packages/effect-domains/package.json", "examples/reading-list/package.json", "apps/application-ui/package.json", "apps/application-ui/assets.ts", "apps/application-ui/build.ts", "apps/application-ui/dist/client.js", "apps/application-ui/dist/style.css"]) files.push(join(root, path))
      const hashes = []
      const hash = createHash("sha256")
      for (const filename of files.sort()) {
        const content = await readFile(filename)
        const fileHash = createHash("sha256").update(content).digest("hex")
        const name = relative(root, filename)
        hashes.push({ path: name, sha256: fileHash })
        hash.update(name).update("\0").update(fileHash).update("\n")
      }
      return { sha256: hash.digest("hex"), files: hashes }
    },
    catch: (error) => new AcceptanceError({ boundary: "build", message: String(error) }),
  })
  return {
    application: "reading-list", ...identity,
    catalogHash: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
    nativeContractsHash: createHash("sha256").update(JSON.stringify(inspection)).digest("hex"),
    nativeContracts: inspection,
    effect: "4.0.0-rc.112", bun: Bun.version,
  }
})
