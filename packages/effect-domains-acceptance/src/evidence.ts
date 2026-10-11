import { Array, Effect, Layer, Order, Predicate, Redacted, Schema, String as Text, flow, pipe } from "effect"
import { ApplicationInspect } from "effect-domains/application-inspect"
import { createHash } from "node:crypto"
import type { Dirent, MakeDirectoryOptions, WriteFileOptions } from "node:fs"
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { ApplicationIR } from "effect-domains/application"
import { AcceptanceError, BuildIdentity, type Catalog, FileHashSchema, RunEvidence } from "./model.ts"

const hashedSourceExtension = /\.(ts|json|html|css)$/

const anyFile = /./

const isApplication = (input: unknown): input is ApplicationIR => Predicate.hasProperty(input, "group")

const ApplicationSchema = Schema.declare(isApplication)

const PathsSchema = Schema.Array(Schema.String)

/** Paths are repo-relative because the build identity must not depend on the checkout location; `builtRoots` hold bundled outputs. */
export class EvidenceIdentity extends Schema.Class<EvidenceIdentity>("EvidenceIdentity")({
  name: Schema.NonEmptyString,
  application: ApplicationSchema,
  walkedRoots: PathsSchema,
  builtRoots: PathsSchema,
  files: PathsSchema,
  effect: Schema.NonEmptyString,
}) {}

type FileHash = typeof FileHashSchema.Type

const directoryOptions: MakeDirectoryOptions = { recursive: true, mode: 0o700 }

const fileOptions: WriteFileOptions = { mode: 0o600 }

const listingOptions = { withFileTypes: true } as const

const evidenceError = (message: string) => AcceptanceError.make({ boundary: "evidence", message })

const buildError = (message: string) => AcceptanceError.make({ boundary: "build", message })

const describeEvidenceFailure = flow(String, evidenceError)

const describeBuildFailure = flow(String, buildError)

const asEvidenceFailure = (error: AcceptanceError) => evidenceError(error.message)

const sha256 = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex")

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const directory = Effect.fn("Acceptance.evidence.directory")(function* (path: string) {
  yield* Effect.tryPromise({ try: () => mkdir(path, directoryOptions), catch: describeEvidenceFailure })

  return path
})

const checkExistence = (path: string) => Effect.tryPromise({ try: () => Bun.file(path).exists(), catch: describeEvidenceFailure })

const read = (path: string) => Effect.tryPromise({ try: () => Bun.file(path).json(), catch: describeEvidenceFailure })

const save = Effect.fn("Acceptance.evidence.save")(function* <A, I>(path: string, schema: Schema.Codec<A, I>, value: A) {
  const encoded = yield* pipe(value, Schema.encodeEffect(schema), Effect.mapError(describeEvidenceFailure))
  const staged = `${path}.pending`
  const content = pretty(encoded)

  yield* Effect.tryPromise({ try: () => writeFile(staged, content, fileOptions), catch: describeEvidenceFailure })
  yield* Effect.tryPromise({ try: () => rename(staged, path), catch: describeEvidenceFailure })
})

const listEntries = (path: string) => Effect.tryPromise({ try: () => readdir(path, listingOptions), catch: describeBuildFailure })

const filesUnder = (pattern: RegExp) => (path: string): Effect.Effect<ReadonlyArray<string>, AcceptanceError> => pipe(
  listEntries(path),
  Effect.flatMap(Effect.forEach(visit(pattern, path))),
  Effect.map(Array.flatten),
)

const visit = (pattern: RegExp, parent: string) => (entry: Dirent): Effect.Effect<ReadonlyArray<string>, AcceptanceError> => {
  const filename = join(parent, entry.name)
  const selected = pattern.test(entry.name)
  const files = selected ? Array.of(filename) : Array.empty<string>()

  return entry.isDirectory()
    ? filesUnder(pattern)(filename)
    : Effect.succeed(files)
}

const under = (root: string) => (path: string) => join(root, path)

const hashFile = (root: string) => Effect.fn("Acceptance.evidence.hashFile")(function* (filename: string) {
  const content = yield* Effect.tryPromise({ try: () => readFile(filename), catch: describeBuildFailure })
  const path = relative(root, filename)
  const digest = sha256(content)

  return FileHashSchema.make({ path, sha256: digest })
})

const manifestLine = (file: FileHash) => `${file.path}\0${file.sha256}\n`

const manifestHash = (files: ReadonlyArray<FileHash>) => pipe(files, Array.map(manifestLine), Array.join(""), sha256)

const hashedFiles = (root: string) => Effect.fn("Acceptance.evidence.hashedFiles")(function* (groups: ReadonlyArray<ReadonlyArray<string>>) {
  const sorted = pipe(groups, Array.flatten, Array.sort(Order.String))

  return yield* Effect.forEach(sorted, hashFile(root))
})

/** Sources, bundles, the catalog, and the native contracts are hashed separately because a replay is stale when any of them changes. */
const identify = (identity: EvidenceIdentity) => Effect.fn("Acceptance.evidence.identify")(function* (catalog: typeof Catalog.Encoded) {
  const inspection = yield* pipe(ApplicationInspect.describe(identity.application), Effect.mapError(describeBuildFailure))
  const root = new URL("../../../", import.meta.url).pathname
  const walkedPaths = Array.map(identity.walkedRoots, under(root))
  const builtPaths = Array.map(identity.builtRoots, under(root))
  const listed = Array.map(identity.files, under(root))
  const walked = yield* Effect.forEach(walkedPaths, filesUnder(hashedSourceExtension))
  const built = yield* Effect.forEach(builtPaths, filesUnder(anyFile))
  const sourceGroups = Array.append(walked, listed)
  const sources = yield* hashedFiles(root)(sourceGroups)
  const bundles = yield* hashedFiles(root)(built)
  const files = pipe(sources, Array.appendAll(bundles))
  const catalogJson = JSON.stringify(catalog)
  const inspectionJson = JSON.stringify(inspection)

  return BuildIdentity.make({
    application: identity.name,
    sourceHash: manifestHash(sources),
    bundleHash: manifestHash(bundles),
    files,
    catalogHash: sha256(catalogJson),
    nativeContractsHash: sha256(inspectionJson),
    nativeContracts: inspection,
    effect: identity.effect,
    bun: Bun.version,
  })
})

const secretBytes = flow(Redacted.value<string>, Buffer.from)

const containedIn = (content: Buffer) => (secret: Buffer) => content.indexOf(secret) >= 0

const retainedFile = (root: string, secrets: ReadonlyArray<Buffer>) => Effect.fn("Acceptance.evidence.retainedFile")(function* (filename: string) {
  const content = yield* Effect.tryPromise({ try: () => readFile(filename), catch: describeEvidenceFailure })
  const leaked = Array.some(secrets, containedIn(content))
  const path = relative(root, filename)

  return leaked ? Array.of(path) : Array.empty<string>()
})

const nonEmptySecret = flow(Redacted.value<string>, Text.isNonEmpty)

/** Every retained file under the run directory that contains a secret, by relative path, because a leaked credential fails the run. */
const scan = Effect.fn("Acceptance.evidence.scan")(function* (path: string, secrets: ReadonlyArray<Redacted.Redacted<string>>) {
  const needles = pipe(secrets, Array.filter(nonEmptySecret), Array.map(secretBytes))
  const retained = yield* pipe(filesUnder(anyFile)(path), Effect.mapError(asEvidenceFailure))
  const sorted = Array.sort(retained, Order.String)
  const leaks = yield* Effect.forEach(sorted, retainedFile(path, needles))

  return Array.flatten(leaks)
})

export const evidenceLayer = (identity: EvidenceIdentity) => {
  const evidence = RunEvidence.of({ directory, exists: checkExistence, read, save, identify: identify(identity), scan })

  return Layer.succeed(RunEvidence, evidence)
}
