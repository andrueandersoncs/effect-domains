import { Array, Console, DateTime, Effect, Function, type Layer, Option, Record, Schema, String, flow, pipe } from "effect"
import { join, resolve } from "node:path"
import { AcceptanceError, type FixtureRuntime, type InputCandidates, type RequirementEvaluation, type RunEvidence } from "./model.ts"
import { type AcceptanceDefinition, RunConfiguration, runAcceptance } from "./runner.ts"

const MinimumConfidenceSchema = Schema.NumberFromString.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))
const MaxActionsSchema = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100))
const DeadlineSecondsSchema = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(600))
const SeedSchema = Schema.NumberFromString.check(Schema.isInt())
const ReplayPathSchema = Schema.OptionFromUndefinedOr(Schema.NonEmptyString)

class CommandLine extends Schema.Class<CommandLine>("CommandLine")({
  output: Schema.NonEmptyString,
  seed: SeedSchema,
  model: Schema.NonEmptyString,
  minimumConfidence: MinimumConfidenceSchema,
  maxActions: MaxActionsSchema,
  deadlineSeconds: DeadlineSecondsSchema,
  replay: ReplayPathSchema,
}) {}

const EncodedCommandLineSchema = Schema.toEncoded(CommandLine)

const acceptanceOptions = ["--output", "--seed", "--model", "--minimum-confidence", "--max-actions", "--deadline-seconds", "--replay"]

const configurationFailure = (message: string) => AcceptanceError.make({ boundary: "configuration", message })

const optionMessage = (name: string) => `Unknown, repeated, or incomplete option ${name}`

const rejectOption = flow(optionMessage, configurationFailure, Effect.fail)

const accepted = (options: Record<string, string>, name: string) => (present: string) => pipe(options, Record.set(name, present), Effect.succeed)

const addOption = (options: Record<string, string>, pair: Array.NonEmptyReadonlyArray<string>) => {
  const name = Array.headNonEmpty(pair)
  const value = pipe(pair, Array.get(1), Option.filter(String.isNonEmpty))
  const known = Array.contains(acceptanceOptions, name)
  const fresh = !Record.has(options, name)
  const acceptable = known && fresh
  const accept = accepted(options, name)
  const rejection = rejectOption(name)
  const reject = Function.constant(rejection)

  return acceptable ? Option.match(value, { onNone: reject, onSome: accept }) : reject()
}

const parseOptions = Effect.fn("Acceptance.parseOptions")(function* (args: ReadonlyArray<string>) {
  const pairs = Array.chunksOf(args, 2)

  return yield* Effect.reduce(pairs, Record.empty<string, string>, addOption)
})

const optionOr = (options: Record<string, string>, fallback: string) => (name: string) => pipe(options, Record.get(name), Option.getOrElse(Function.constant(fallback)))

const defaultOutput = Effect.fn("Acceptance.defaultOutput")(function* () {
  const root = new URL("../../../", import.meta.url).pathname
  const now = yield* DateTime.now
  const stamp = pipe(now, DateTime.formatIso, String.replace(/[:.]/g, "-"))
  const identifier = yield* Effect.sync(() => crypto.randomUUID())

  return join(root, "data", "acceptance", `${stamp}-${identifier}`)
})

const configurationError = (error: Schema.SchemaError) => configurationFailure(`${error}`)

const readConfiguration = Effect.fn("Acceptance.readConfiguration")(function* (definition: AcceptanceDefinition, args: ReadonlyArray<string>) {
  const options = yield* parseOptions(args)
  const fallbackOutput = yield* defaultOutput()
  const output = pipe(options, Record.get("--output"), Option.map(resolve), Option.getOrElse(Function.constant(fallbackOutput)))
  const replay = pipe(options, Record.get("--replay"), Option.map(resolve))

  const encoded = EncodedCommandLineSchema.make({
    output,
    seed: optionOr(options, "42")("--seed"),
    model: optionOr(options, "jev-1.13.0")("--model"),
    minimumConfidence: optionOr(options, "0.55")("--minimum-confidence"),
    maxActions: optionOr(options, `${definition.defaultMaxActions}`)("--max-actions"),
    deadlineSeconds: optionOr(options, "180")("--deadline-seconds"),
    replay: Option.getOrUndefined(replay),
  })

  const commandLine = yield* pipe(encoded, Schema.decodeUnknownEffect(CommandLine), Effect.mapError(configurationError))

  return RunConfiguration.make({
    output: commandLine.output,
    seed: commandLine.seed,
    model: commandLine.model,
    minimumConfidence: commandLine.minimumConfidence,
    maxActions: commandLine.maxActions,
    deadlineSeconds: commandLine.deadlineSeconds,
    replay: commandLine.replay,
  })
})

const setExitCode = (passed: boolean) =>
  Effect.sync(() => {
    process.exitCode = passed ? 0 : 1
  })

const failedExit = setExitCode(false)

const reportFailure = Effect.fn("Acceptance.reportFailure")(function* (error: unknown) {
  const message = `${error}`

  yield* Console.error(message)
  yield* failedExit
})

const acceptance = Effect.fn("Acceptance.main")(function* (definition: AcceptanceDefinition, args: ReadonlyArray<string>) {
  const configuration = yield* readConfiguration(definition, args)
  const passed = yield* runAcceptance(definition, configuration)

  yield* setExitCode(passed)
})

type AcceptanceServices = RunEvidence | FixtureRuntime | InputCandidates | RequirementEvaluation

const commandLine = Effect.sync(() => process.argv)

/** The command line is shared because every application exposes the same options, key handling, and exit code. */
export const runAcceptanceCli = Effect.fn("Acceptance.runCli")(function* (definition: AcceptanceDefinition, services: Layer.Layer<AcceptanceServices>, help: string) {
  const argv = yield* commandLine
  const args = Array.drop(argv, 2)
  const wantsHelp = Array.contains(argv, "--help")

  if (wantsHelp) return yield* Console.log(help)

  return yield* pipe(acceptance(definition, args), Effect.provide(services), Effect.catch(reportFailure))
})
