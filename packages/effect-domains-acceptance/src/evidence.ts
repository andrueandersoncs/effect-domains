import { Array, Effect, Equal, Layer, Order, Predicate, Redacted, Schema, String as Text, Struct, flow, pipe } from "effect"
import { ApplicationInspect } from "effect-domains/application-inspect"
import { createHash } from "node:crypto"
import type { Dirent, MakeDirectoryOptions, WriteFileOptions } from "node:fs"
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { ApplicationIR } from "effect-domains/application"
import { AcceptanceError, BuildIdentity, Catalog, type CatalogImport, FileHashSchema, ImportedCatalogSchema, RunEvidence } from "./model.ts"

const hashedSourceExtension = /\.(ts|json|html|css)$/

const anyFile = /./

const isApplication = (input: unknown): input is ApplicationIR => Predicate.hasProperty(input, "group")

const ApplicationSchema = Schema.declare(isApplication)

const PathsSchema = Schema.Array(Schema.String)

/** Paths are repo-relative because the build identity must not depend on the checkout location. */
export class EvidenceIdentity extends Schema.Class<EvidenceIdentity>("EvidenceIdentity")({
  name: Schema.NonEmptyString,
  application: ApplicationSchema,
  walkedRoots: PathsSchema,
  builtRoots: PathsSchema,
  files: PathsSchema,
  effect: Schema.NonEmptyString,
}) {}

const directoryOptions: MakeDirectoryOptions = { recursive: true, mode: 0o700 }

const fileOptions: WriteFileOptions = { mode: 0o600 }

const listingOptions = { withFileTypes: true } as const

const evidenceError = (message: string) => AcceptanceError.make({ boundary: "evidence", message })

const buildError = (message: string) => AcceptanceError.make({ boundary: "build", message })

const describeEvidenceFailure = flow(String, evidenceError)

const describeBuildFailure = flow(String, buildError)

const asEvidenceFailure = (error: AcceptanceError) => evidenceError(error.message)

export const sha256 = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex")

export const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

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

const ledgerLine = (file: typeof FileHashSchema.Type) => `${file.path}\0${file.sha256}\n`

const importedBy = (catalog: typeof Catalog.Encoded) => (candidate: typeof Catalog.Encoded) => {
  const pins = (entry: typeof CatalogImport.Encoded) => Equal.equals(entry.catalog, candidate.id) && Equal.equals(entry.revision, candidate.revision)

  return Array.some(catalog.imports, pins)
}

const importedCatalog = (imported: typeof Catalog.Encoded) => {
  const encoded = JSON.stringify(imported)
  const digest = sha256(encoded)

  return ImportedCatalogSchema.make({ id: imported.id, revision: imported.revision, sha256: digest })
}

const importOrder = Order.mapInput(Order.String, (imported: typeof ImportedCatalogSchema.Type) => `${imported.id}@${imported.revision}`)

const imported = (catalog: typeof Catalog.Encoded, imports: ReadonlyArray<typeof Catalog.Encoded>) => pipe(imports, Array.filter(importedBy(catalog)), Array.map(importedCatalog), Array.sort(importOrder))

/** The catalog hash covers the root catalog and the exact content of every resolved import because a pinned revision alone cannot detect an edited import. */
const identify = (identity: EvidenceIdentity) => Effect.fn("Acceptance.evidence.identify")(function* (catalog: typeof Catalog.Encoded, imports: ReadonlyArray<typeof Catalog.Encoded>) {
  const inspection = yield* pipe(ApplicationInspect.describe(identity.application), Effect.mapError(describeBuildFailure))
  const root = new URL("../../../", import.meta.url).pathname
  const walkedPaths = Array.map(identity.walkedRoots, under(root))
  const builtPaths = Array.map(identity.builtRoots, under(root))
  const walked = yield* Effect.forEach(walkedPaths, filesUnder(hashedSourceExtension))
  const built = yield* Effect.forEach(builtPaths, filesUnder(anyFile))
  const listed = Array.map(identity.files, under(root))
  const sources = Array.flatten(walked)
  const outputs = Array.flatten(built)
  const discovered = Array.appendAll(sources, outputs)
  const all = Array.appendAll(discovered, listed)
  const sorted = Array.sort(all, Order.String)
  const files = yield* Effect.forEach(sorted, hashFile(root))
  const ledger = pipe(files, Array.map(ledgerLine), Array.join(""))
  const importedCatalogs = imported(catalog, imports)
  const catalogJson = JSON.stringify([catalog, importedCatalogs])
  const inspectionJson = JSON.stringify(inspection)

  return BuildIdentity.make({
    application: identity.name,
    sha256: sha256(ledger),
    files,
    importedCatalogs,
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
