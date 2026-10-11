import { Array, Config, Console, DateTime, Effect, Equal, Function, Option, Predicate, Record, Schema, String as Text, flow, pipe } from "effect"
import { resolve } from "node:path"
import { configurationFailure, parseOptions, reportFailure } from "./cli.ts"
import { ConsumerSchema, EvidenceClassSchema, ExportManifest, PrunePlan, exportRun, inspect, prune } from "./governance.ts"

const help = `Evidence governance for retained acceptance evidence (local-only policy)
bun run acceptance:evidence inspect DIRECTORY [--as owner|qa|export] [--file RELATIVE-PATH]
bun run acceptance:evidence export DIRECTORY --output DESTINATION [--include screenshot,server-log]
bun run acceptance:evidence prune ROOT [--now ISO-8601] [--apply]

Every retained artifact belongs to a declared evidence class (run, scenario, verifier,
fault and calibration reports; model exchanges, observations and protected probe
payloads embedded in reports; screenshots; server logs; governance records). Runs write
an ownership marker recording the application's EvidencePolicy at start, and a lineage
manifest (build hashes, catalog revisions, results, replay source, artifact hashes and
the run-time secret/protected-record seal) at the end.

inspect  owner (default) reads every artifact, protected records in full, with secret-keyed
         JSON values always masked. qa reads reports with secret-keyed values masked and
         policy-protected probe/operation payloads replaced by SHA-256 digests, and
         screenshots/logs only as digests; it requires a run-owned directory. export
         reads only an export bundle (its manifest and exported files).
export   writes a new bundle (never overwrites): JSON redacted for the export consumer,
         screenshots and server logs excluded unless --include names them, unclassified
         files never exported, and manifest.json with file hashes, exclusions, the policy
         revision, and a secret scan of the exact bundle bytes (TYPESAFE_API_KEY when
         configured plus structural detectors). Any finding refuses the export.
prune    plans retention for run-owned directories under ROOT (screenshots/logs after 30
         days, reports after 180; governance records are never deleted). Dry-run unless
         --apply. Unowned or unsealed directories are never touched; deletions are
         recorded in lineage.json before files are removed, and a replay source keeps its
         lineage while a replay's lineage references it.
`

const commands = ["inspect", "export", "prune"]

const inspectOptions = ["--as", "--file"]

const exportOptions = ["--output", "--include"]

const pruneOptions = ["--now"]

const applyFlag = "--apply"

const isApplyFlag = (arg: string) => Equal.equals(arg, applyFlag)

const isCommand = (name: string) => Array.contains(commands, name)

const usage = configurationFailure("Usage: acceptance:evidence <inspect|export|prune> DIRECTORY [options]; see --help")

const describeSchemaFailure = flow(String, configurationFailure)

const ClassesSchema = Schema.Array(EvidenceClassSchema)

const decodeConsumer = flow(Schema.decodeUnknownEffect(ConsumerSchema), Effect.mapError(describeSchemaFailure))

const decodeClasses = flow(Schema.decodeUnknownEffect(ClassesSchema), Effect.mapError(describeSchemaFailure))

const optionValue = (options: Record<string, string>, name: string) => Record.get(options, name)

const printEncoded = <A, I>(schema: Schema.Codec<A, I>) => Effect.fn("Acceptance.evidence.print")(function* (value: A) {
  const encoded = yield* pipe(value, Schema.encodeEffect(schema), Effect.mapError(describeSchemaFailure))
  const text = JSON.stringify(encoded, null, 2)

  yield* Console.log(text)
})

const inspectCommand = Effect.fn("Acceptance.evidence.inspectCommand")(function* (directory: string, args: ReadonlyArray<string>) {
  const options = yield* parseOptions(inspectOptions, args)
  const named = pipe(optionValue(options, "--as"), Option.getOrElse(Function.constant("owner")))
  const consumer = yield* decodeConsumer(named)
  const file = optionValue(options, "--file")
  const path = resolve(directory)
  const text = yield* inspect(path, consumer, file)
  const trimmed = Text.trimEnd(text)

  yield* Console.log(trimmed)
})

const missingOutput = configurationFailure("export requires --output DESTINATION")

const splitClasses = flow(Text.split(","), Array.filter(Text.isNonEmpty))

const exportCommand = Effect.fn("Acceptance.evidence.exportCommand")(function* (directory: string, args: ReadonlyArray<string>) {
  const options = yield* parseOptions(exportOptions, args)
  const destination = yield* pipe(optionValue(options, "--output"), Effect.fromOption, Effect.mapError(Function.constant(missingOutput)))
  const included = pipe(optionValue(options, "--include"), Option.map(splitClasses), Option.getOrElse(Array.empty<string>))
  const include = yield* decodeClasses(included)
  const apiKey = yield* pipe(Config.redacted("TYPESAFE_API_KEY"), Config.option)
  const source = resolve(directory)
  const target = resolve(destination)
  const manifest = yield* exportRun(source, target, include, apiKey)

  yield* printEncoded(ExportManifest)(manifest)
})

const invalidNow = (text: string) => configurationFailure(`--now must be an ISO-8601 instant, got ${text}`)

const parseNow = (text: string) => {
  const invalid = invalidNow(text)

  return pipe(DateTime.make(text), Option.map(DateTime.toUtc), Effect.fromOption, Effect.mapError(Function.constant(invalid)))
}

const pruneCommand = Effect.fn("Acceptance.evidence.pruneCommand")(function* (root: string, args: ReadonlyArray<string>) {
  const apply = Array.some(args, isApplyFlag)
  const pairs = Array.filter(args, Predicate.not(isApplyFlag))
  const options = yield* parseOptions(pruneOptions, pairs)
  const current = yield* DateTime.now
  const requested = optionValue(options, "--now")
  const fallback = Effect.succeed(current)
  const now = yield* Option.match(requested, { onNone: Function.constant(fallback), onSome: parseNow })
  const path = resolve(root)
  const plan = yield* prune(path, now, apply)

  yield* printEncoded(PrunePlan)(plan)
})

const dispatch = (command: string, target: string, args: ReadonlyArray<string>) => {
  if (Equal.equals(command, "inspect")) return inspectCommand(target, args)

  return Equal.equals(command, "export") ? exportCommand(target, args) : pruneCommand(target, args)
}

const evidence = Effect.fn("Acceptance.evidence.main")(function* (args: ReadonlyArray<string>) {
  const command = yield* pipe(Array.get(args, 0), Option.filter(isCommand), Effect.fromOption, Effect.mapError(Function.constant(usage)))
  const target = yield* pipe(Array.get(args, 1), Option.filter(Text.isNonEmpty), Effect.fromOption, Effect.mapError(Function.constant(usage)))
  const rest = Array.drop(args, 2)

  yield* dispatch(command, target, rest)
})

const evidenceCli = Effect.fn("Acceptance.evidence.cli")(function* () {
  const argv = yield* Effect.sync(() => process.argv)
  const args = Array.drop(argv, 2)
  const wantsHelp = Array.contains(argv, "--help")

  if (wantsHelp) return yield* Console.log(help)

  return yield* pipe(evidence(args), Effect.catch(reportFailure))
})

const program = evidenceCli()

await Effect.runPromise(program)
